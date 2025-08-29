// app/api/bot/tick/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isWeekdayET, isMarketHoursET, yyyyMmDdET, nowET } from "@/lib/market";
import {
  submitBracketBuy,
  closePositionMarket,
  replaceTpSlIfBetter,
  // FREE IEX data helpers from alpaca.ts:
  getBars1m,
  premarketRangeISO,
  computePremarketLevelsFromBars,
  spreadGuardOK,
  // NEW: fetch real Alpaca balances
  getAccount,
  // NEW: market sell helper for partial TP
  sellMarket,
} from "@/lib/alpaca";

// ✅ Use the cached FMP helpers
import { fmpQuoteCached } from "../../../../lib/fmpCached";

/** Extract a numeric price from FMP quote payload */
function priceFromFmp(q: any): number | null {
  const n = Number(q?.price ?? q?.c ?? q?.close ?? q?.previousClose);
  return Number.isFinite(n) ? n : null;
}

/** ───────────────── Throttle / Coalesce ───────────────── */
let lastTickAt = 0;
let lastTickResponse: any = null;
let pendingTick: Promise<any> | null = null;
const MIN_TICK_MS = 200;

/** ───────────────── Config ───────────────── */
const START_CASH = 4000;
const INVEST_BUDGET = 4000;          // cap per trade; if cash < 4k, use all cash
const TARGET_PCT = 0.10;             // +10% take-profit
const STOP_PCT   = -0.05;            // -5% stop-loss
const TOP_CANDIDATES = 8;

// Ratchet config
const RATCHET_ENABLED = true;
const RATCHET_STEP_PCT = 0.05; // trail jumps every +5% from entry (compounded)
const RATCHET_LIFT_BROKER_CHILDREN = true; // keep trying to lift TP/SL children upward (never down)
const RATCHET_VIRTUAL_EXITS = true;        // also do virtual exits if dyn TP/SL hit

// Alpaca TP/SL lift cooldown
const LIFT_COOLDOWN_MS = 6000;
const ratchetLiftMemo: Record<string, { lastStep: number; lastLiftAt: number }> = {};

// ── Balanced profile (time-decayed thresholds across 9:30–9:44) ──
const DECAY_START_MIN = 0;    // at 9:30 (inclusive)
const DECAY_END_MIN   = 14;   // at 9:44 (inclusive)

// Volume pulse: 1.20x → 1.10x
const VOL_MULT_START = 1.20;
const VOL_MULT_END   = 1.10;

// Near-OR tolerance: 0.30% → 0.45%
const NEAR_OR_START  = 0.003;
const NEAR_OR_END    = 0.0045;

// VWAP reclaim band: 0.20% → 0.30%
const VWAP_BAND_START = 0.002;
const VWAP_BAND_END   = 0.003;

// Execution guards (price band fixed; spread is dynamic below)
const PRICE_MIN = 1;
const PRICE_MAX = 70;

// AI pick freshness
const FRESHNESS_MS = 30_000;

// Require AI pick (true = don't fallback to top-1, except in FORCE window)
const REQUIRE_AI_PICK = true;

/** ───────── Balanced liquidity guard ─────────
 * - Shares/min: max(8,000, 0.25% of float)
 * - Dollar-volume/min: ≥ $200,000
 * - Fallbacks if float unknown: flat 10k/min
 */
const MIN_SHARES_ABS = 8_000;
const FLOAT_MIN_PCT_PER_MIN = 0.0025; // 0.25%
const MIN_DOLLAR_VOL = 200_000;

/** ───────────────── Time Windows (ET) ───────────────── */
function inPreScanWindow() {
  const d = nowET();
  const mins = d.getHours() * 60 + d.getMinutes();
  const s = d.getSeconds();
  return mins >= 9 * 60 + 14 && mins <= 9 * 60 + 29 && s <= 59;
}
function inScanWindow() {
  const d = nowET();
  const m = d.getHours() * 60 + d.getMinutes();
  const s = d.getSeconds();
  return m >= 9 * 60 + 30 && m <= 9 * 60 + 44 && s <= 59;
}
function inForceWindow() {
  const d = nowET();
  return d.getHours() === 9 && (d.getMinutes() === 45 || d.getMinutes() === 46);
}
function inEndOfForceFailsafe() {
  const d = nowET();
  return d.getHours() === 9 && d.getMinutes() === 46 && d.getSeconds() >= 30;
}
function isMandatoryExitET() {
  const d = nowET();
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= (15 * 60 + 55);
}

/** ───────────────── Buy-the-Dip Config ───────────────── */
const DIP_MIN_PCT = 0.08;   // ≥ 8% pullback from 9:30 open
const DIP_MAX_PCT = 0.20;   // ≤ 20% (avoid catching a collapse)
const DIP_CONFIRM_EITHER = true; // true = (break prev high OR reclaim VWAP)

/** ───────────────── Types & Helpers ───────────────── */
type SnapStock = {
  ticker: string;
  price?: number | null;
  changesPercentage?: number | null;
  volume?: number | null;
  avgVolume?: number | null;
  marketCap?: number | null;
  float?: number | null;
};
type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };

function getBaseUrl(req: Request) {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = (req.headers.get("x-forwarded-proto") || "http").split(",")[0].trim();
  const host  = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

// Last-good (same-day) snapshot cache
let lastGoodSnapshot: { stocks: SnapStock[]; updatedAt: string } | null = null;
let lastGoodSnapshotDay: string | null = null;

async function getSnapshot(baseUrl: string): Promise<{ stocks: SnapStock[]; updatedAt: string } | null> {
  try {
    const r = await fetch(`${baseUrl}/api/stocks/snapshot`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    const snap = {
      stocks: Array.isArray(j?.stocks) ? j.stocks : [],
      updatedAt: j?.updatedAt || new Date().toISOString(),
    };
    if (snap.stocks.length) {
      const today = yyyyMmDdET();
      const snapDay = yyyyMmDdLocal(new Date(snap.updatedAt));
      if (snapDay === today) {
        lastGoodSnapshot = snap;
        lastGoodSnapshotDay = today;
      }
    }
    return snap;
  } catch {
    return null;
  }
}

function yyyyMmDdLocal(d: Date) {
  const dt = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mo = String(dt.getMonth() + 1).padStart(2, "0");
  const da = String(dt.getDate()).padStart(2, "0");
  return `${dt.getFullYear()}-${mo}-${da}`;
}
function yyyyMmDd(date: Date) {
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const da = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mo}-${da}`;
}

/** ─────────── AI pick parsers (up to TWO picks) ─────────── */
function tokenizeTickers(txt: string): string[] {
  if (!txt) return [];
  return Array.from(new Set((txt.toUpperCase().match(/\b[A-Z]{1,5}\b/g) || [])));
}
function parseTwoPicksFromResponse(rJson: any, allowed?: string[]): string[] {
  const allowSet = new Set((allowed || []).map(s => s.toUpperCase()));
  const out: string[] = [];

  if (Array.isArray(rJson?.picks)) {
    for (const s of rJson.picks) {
      const u = String(s || "").toUpperCase();
      if (/^[A-Z][A-Z0-9.\-]*$/.test(u) && (!allowSet.size || allowSet.has(u))) out.push(u);
      if (out.length >= 2) return out;
    }
  }

  const fields = [
    rJson?.ticker, rJson?.symbol, rJson?.pick, rJson?.Pick,
    rJson?.data?.ticker, rJson?.data?.symbol,
  ];
  for (const f of fields) {
    const u = typeof f === "string" ? f.toUpperCase() : "";
    if (/^[A-Z][A-Z0-9.\-]*$/.test(u) && (!allowSet.size || allowSet.has(u)) && !out.includes(u)) out.push(u);
    if (out.length >= 2) return out;
  }

  let txt = String(rJson?.recommendation ?? rJson?.text ?? rJson?.message ?? "");
  txt = txt.replace(/[*_`~]/g, "").replace(/^-+\s*/gm, "");
  const m1 = /Pick\s*:?\s*([A-Z][A-Z0-9.\-]*)/i.exec(txt);
  const m2 = /Second[^A-Za-z0-9]{0,6}choice[^A-Za-z0-9]{0,6}:?\s*([A-Z][A-Z0-9.\-]*)/i.exec(txt);
  const cands = [m1?.[1], m2?.[1]].filter(Boolean).map(s => String(s).toUpperCase());
  for (const c of cands) {
    if ((!allowSet.size || allowSet.has(c)) && !out.includes(c)) out.push(c);
    if (out.length >= 2) return out;
  }

  const toks = tokenizeTickers(txt).filter(t => !allowSet.size || allowSet.has(t));
  for (const t of toks) {
    if (!out.includes(t)) out.push(t);
    if (out.length >= 2) break;
  }
  return out;
}

/** Fetch/refresh recommendation and return up to two picks. */
async function ensureRollingRecommendationTwo(
  req: Request,
  topStocks: SnapStock[],
  freshnessMs = FRESHNESS_MS
): Promise<{ primary: string | null; secondary: string | null; lastRecRow: any | null }> {
  const now = nowET();
  const today = yyyyMmDd(now);
  let lastRec = await prisma.recommendation.findFirst({ orderBy: { id: "desc" } });

  const lastAt = lastRec?.at instanceof Date ? lastRec.at.getTime() : 0;
  const tooOld = !lastAt || (now.getTime() - lastAt > freshnessMs);
  const notToday = lastRec ? yyyyMmDd(lastRec.at as Date) !== today : true;
  const notInTop = lastRec?.ticker ? !topStocks.some(s => s.ticker === lastRec!.ticker) : true;

  let primary: string | null = lastRec?.ticker ?? null;
  let secondary: string | null = null;

  const base = getBaseUrl(req);
  const refresh = async () => {
    try {
      const rRes = await fetch(`${base}/api/recommendation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stocks: topStocks, forcePick: true, requirePick: true }),
        cache: "no-store",
      });
      if (rRes.ok) {
        const rJson = await rRes.json();
        const allowed = topStocks.map(s => s.ticker);
        const picks = parseTwoPicksFromResponse(rJson, allowed);
        if (picks.length) {
          primary = picks[0] || primary;
          secondary = picks[1] || null;
          const inTop = topStocks.some(s => s.ticker === primary);
          if (inTop) {
            let ref: number | null = Number(topStocks.find((s) => s.ticker === primary)?.price ?? NaN);
            if (!Number.isFinite(Number(ref))) {
              const q = await fmpQuoteCached(primary!);
              const p = priceFromFmp(q);
              if (p != null) ref = p;
            }
            const priceNum = Number.isFinite(Number(ref)) ? Number(ref) : null;
            const data: any = { ticker: primary! };
            if (typeof priceNum === "number" && Number.isFinite(priceNum)) data.price = priceNum;
            lastRec = await prisma.recommendation.create({ data });
          }
        }
      }
    } catch { /* ignore */ }
  };

  if (tooOld || notToday || notInTop) {
    await refresh();
  } else {
    await refresh(); // still try to extract secondary
  }

  return { primary: primary ?? null, secondary: secondary ?? null, lastRecRow: lastRec || null };
}

/** Intraday 1-min data helpers (FMP session candles) */
function toET(dateIso: string) {
  return new Date(new Date(dateIso).toLocaleString("en-US", { timeZone: "America/New_York" }));
}
function isSameETDay(d: Date, ymd: string) {
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}` === ymd;
}
async function fetchCandles1m(symbol: string, limit = 240): Promise<Candle[]> {
  const rel = `/api/fmp/candles?symbol=${encodeURIComponent(symbol)}&interval=1min&limit=${limit}`;
  const res = await fetch(rel, { cache: "no-store" });
  if (!res.ok) return [];
  const j = await res.json();
  const arr = Array.isArray(j?.candles) ? j.candles : [];
  return arr.map((c: any) => ({
    date: c.date,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
  }));
}

/** Signals */
function computeOpeningRange(candles: Candle[], todayYMD: string) {
  const window = candles.filter((c) => {
    const d = toET(c.date);
    return isSameETDay(d, todayYMD) && d.getHours() === 9 && d.getMinutes() >= 30 && d.getMinutes() <= 33;
  });
  if (!window.length) return null;
  const high = Math.max(...window.map((c) => c.high));
  const low  = Math.min(...window.map((c) => c.low));
  return { high, low, count: window.length };
}
function computeSessionVWAP(candles: Candle[], todayYMD: string) {
  const session = candles.filter((c) => {
    const d = toET(c.date);
    const mins = d.getHours() * 60 + d.getMinutes();
    return isSameETDay(d, todayYMD) && mins >= 9 * 60 + 30;
  });
  if (!session.length) return null;
  let pvSum = 0, volSum = 0;
  for (const c of session) {
    const typical = (c.high + c.low + c.close) / 3;
    pvSum += typical * c.volume;
    volSum += c.volume;
  }
  return volSum > 0 ? pvSum / volSum : null;
}
function computeVolumePulse(candles: Candle[], todayYMD: string, lookback = 5) {
  const dayC = candles.filter((c) => isSameETDay(toET(c.date), todayYMD));
  if (dayC.length < lookback + 1) return null;
  const latest = dayC[dayC.length - 1];
  const prior  = dayC.slice(-1 - lookback, -1);
  const avgPrior = prior.reduce((s, c) => s + c.volume, 0) / lookback;
  if (!avgPrior) return { mult: null as number | null, latestVol: latest.volume, avgPrior };
  return { mult: latest.volume / avgPrior, latestVol: latest.volume, avgPrior };
}

/** Buy-the-Dip helpers */
function sessionOpenAt930(candles: Candle[], todayYMD: string): number | null {
  const c = candles.find((k) => {
    const d = toET(k.date);
    return isSameETDay(d, todayYMD) && d.getHours() === 9 && d.getMinutes() === 30;
  });
  return c ? c.open : null;
}
function dayMinLowSoFar(candles: Candle[], todayYMD: string): number | null {
  const day = candles.filter((c) => isSameETDay(toET(c.date), todayYMD));
  if (!day.length) return null;
  return Math.min(...day.map((c) => c.low));
}
function dipArmedNow(params: {
  candles: Candle[];
  todayYMD: string;
  vwap: number | null;
}): { armed: boolean; meta: any } {
  const { candles, todayYMD, vwap } = params;
  const day = candles.filter((c) => isSameETDay(toET(c.date), todayYMD));
  if (day.length < 2) return { armed: false, meta: { reason: "not_enough_bars" } };

  const last = day[day.length - 1];
  const prev = day[day.length - 2];

  const open930 = sessionOpenAt930(candles, todayYMD);
  const minLow = dayMinLowSoFar(candles, todayYMD);
  if (open930 == null || minLow == null || open930 <= 0) {
    return { armed: false, meta: { reason: "missing_open_or_min" } };
  }

  const pullbackPct = (open930 - minLow) / open930;
  const withinDipBand = pullbackPct >= DIP_MIN_PCT && pullbackPct <= DIP_MAX_PCT;

  const brokePrevHigh = last.close > prev.high;
  const reclaimedVWAP = vwap != null ? last.close >= vwap : false;
  const confirmOK = DIP_CONFIRM_EITHER ? (brokePrevHigh || reclaimedVWAP) : (brokePrevHigh && reclaimedVWAP);
  const lastGreen = last.close >= last.open;

  const armed = !!(withinDipBand && confirmOK && lastGreen);

  return {
    armed,
    meta: {
      open930,
      minLow,
      pullbackPct,
      withinDipBand,
      brokePrevHigh,
      reclaimedVWAP,
      lastGreen,
    }
  };
}

/** Ratcheting targets (never lower than initial stop) */
function computeRatchetTargets(entry: number, dayHighSinceOpen: number) {
  if (!RATCHET_ENABLED) return null;
  if (!Number.isFinite(entry) || !Number.isFinite(dayHighSinceOpen) || entry <= 0) return null;
  const upFromEntry = dayHighSinceOpen / entry - 1;
  const step = Math.max(0.0001, RATCHET_STEP_PCT);
  const steps = Math.max(0, Math.floor(upFromEntry / step));
  const factor = Math.pow(1 + step, steps);
  const initialSL = entry * (1 + STOP_PCT); // entry * 0.95
  const initialTP = entry * (1 + TARGET_PCT);
  const dynSL = Math.max(initialSL, initialSL * factor);
  const dynTP = initialTP * factor;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    steps,
    dynSL: round2(dynSL),
    dynTP: round2(dynTP),
    initialSL: round2(initialSL),
    initialTP: round2(initialTP),
  };
}

/** Premarket memo (from Alpaca) */
type PreMemo = {
  pmHigh: number;
  pmLow: number;
  pmVol: number;
  fetchedAt: number;
};
const scanMemo: Record<string, PreMemo> = {};

/** Balanced profile decay helpers */
function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function minutesSince930ET() {
  const d = nowET();
  const mins = d.getHours() * 60 + d.getMinutes();
  const t = mins - (9 * 60 + 30);
  return Math.max(0, Math.min(DECAY_END_MIN, t));
}

/** Float helpers + liquidity guard */
async function fetchFloatShares(
  symbol: string,
  lastPrice: number | null,
  snapshot: { stocks: SnapStock[] } | null
): Promise<number | null> {
  const snap = snapshot?.stocks?.find(s => s.ticker === symbol);
  if (snap && Number.isFinite(Number(snap.float))) {
    return Number(snap.float);
  }
  try {
    const r = await fetch(`/api/fmp/float?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const f = Number(j?.float ?? j?.floatShares ?? j?.freeFloat);
      if (Number.isFinite(f) && f > 0) return f;
    }
  } catch {}
  try {
    const r2 = await fetch(`/api/fmp/profile?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    if (r2.ok) {
      const j2 = await r2.json();
      const arr = Array.isArray(j2) ? j2 : (Array.isArray(j2?.profile) ? j2.profile : []);
      const row = arr[0] || j2 || {};
      const f = Number(row.floatShares ?? row.sharesFloat ?? row.freeFloat);
      if (Number.isFinite(f) && f > 0) return f;
      const so = Number(row.sharesOutstanding ?? row.mktCapShares);
      if (Number.isFinite(so) && so > 0) return Math.floor(so * 0.8);
    }
  } catch {}
  const mcap = Number(snap?.marketCap);
  const p = Number(lastPrice);
  if (Number.isFinite(mcap) && Number.isFinite(p) && p > 0) {
    const so = mcap / p;
    if (Number.isFinite(so) && so > 0) {
      return Math.floor(so * 0.8);
    }
  }
  return null;
}
function passesBalancedLiquidityGuard(
  lastClose: number,
  lastVolume: number,
  floatShares: number | null
): { ok: boolean; minSharesReq: number; dollarVol: number } {
  const dollarVol = lastClose * lastVolume;
  let minSharesReq = MIN_SHARES_ABS;
  if (Number.isFinite(Number(floatShares)) && floatShares! > 0) {
    const byFloat = Math.floor(floatShares! * FLOAT_MIN_PCT_PER_MIN);
    minSharesReq = Math.max(MIN_SHARES_ABS, byFloat);
  } else {
    minSharesReq = 10_000;
  }
  const sharesOK = lastVolume >= minSharesReq;
  const dollarsOK = dollarVol >= MIN_DOLLAR_VOL;
  return { ok: sharesOK && dollarsOK, minSharesReq, dollarVol };
}

/** Dynamic spread limit */
function dynamicSpreadLimitPct(now: Date, price?: number | null, phase: "scan" | "force" = "scan"): number {
  const toPct = (v: number) => Math.max(0.001, Math.min(0.02, v));
  let base =
    phase === "force"
      ? 0.007
      : (function () {
          const mins = now.getHours() * 60 + now.getMinutes();
          if (mins <= 9 * 60 + 34) return 0.008;
          if (mins <= 9 * 60 + 39) return 0.006;
          return 0.005;
        })();

  const p = Number(price);
  if (Number.isFinite(p)) {
    if (p < 2) base = Math.min(base, 0.012);
    else if (p < 5) base = Math.min(base, 0.008);
  }
  return toPct(base);
}

/** ───────────────── Evaluate-only pass for a ticker ───────────────── */
async function evaluateEntrySignals(
  ticker: string,
  snapshot: { stocks: SnapStock[] } | null,
  today: string
): Promise<{
  eligible: boolean;
  armed: boolean;
  armedMomentum: boolean;
  armedDip: boolean;
  refPrice: number | null;
  meta: any;
  debug: any;
}> {
  const dbg: any = {};
  const candles = await fetchCandles1m(ticker, 240);
  const day = candles.filter((c) => isSameETDay(toET(c.date), today));
  if (!day.length) {
    return { eligible: false, armed: false, armedMomentum: false, armedDip: false, refPrice: null, meta: { reason: "no_day_candles" }, debug: dbg };
  }
  const last = day[day.length - 1];

  // Price band
  if (last.close < PRICE_MIN || last.close > PRICE_MAX) {
    return { eligible: false, armed: false, armedMomentum: false, armedDip: false, refPrice: last.close, meta: { reason: "price_band" }, debug: dbg };
  }
  // Spread guard
  const spreadLimit = dynamicSpreadLimitPct(nowET(), last?.close ?? null, "scan");
  const spreadOK = await spreadGuardOK(ticker, spreadLimit);
  dbg.spread = { limitPct: spreadLimit, spreadOK };
  if (!spreadOK) {
    return { eligible: false, armed: false, armedMomentum: false, armedDip: false, refPrice: last.close, meta: { reason: "spread_guard" }, debug: dbg };
  }

  // Liquidity
  const floatShares = await fetchFloatShares(
    ticker,
    Number.isFinite(Number(last.close)) ? Number(last.close) : null,
    snapshot
  );
  const liq = passesBalancedLiquidityGuard(last.close, Number(last.volume ?? 0), floatShares);
  dbg.liquidity = { float: floatShares ?? null, lastVol: Number(last.volume ?? 0), lastClose: last.close, dollarVol: Math.round(liq.dollarVol), minSharesReq: liq.minSharesReq, ok: liq.ok };
  if (!liq.ok) {
    return { eligible: false, armed: false, armedMomentum: false, armedDip: false, refPrice: last.close, meta: { reason: "liquidity" }, debug: dbg };
  }

  // Momentum thresholds
  const m = minutesSince930ET();
  const t = clamp01((m - DECAY_START_MIN) / (DECAY_END_MIN - DECAY_START_MIN));
  const VOL_MULT_MIN = lerp(VOL_MULT_START, VOL_MULT_END, t);
  const NEAR_OR_PCT  = lerp(NEAR_OR_START,  NEAR_OR_END,  t);
  const VWAP_RECLAIM_BAND = lerp(VWAP_BAND_START, VWAP_BAND_END, t);

  const orRange = computeOpeningRange(candles, today);
  const vwap    = computeSessionVWAP(candles, today);
  const vol     = computeVolumePulse(candles, today, 5);

  const aboveVWAP = vwap != null && last ? last.close >= vwap : false;
  const breakORH  = !!(orRange && last && last.close > orRange.high);
  const nearOR    = !!(orRange && last && last.close >= orRange.high * (1 - NEAR_OR_PCT));
  const vwapRecl  = !!(vwap != null && last && last.close >= vwap && last.low >= vwap * (1 - VWAP_RECLAIM_BAND));
  const volOK     = (vol?.mult ?? 0) >= VOL_MULT_MIN;

  const signals: Record<string, boolean> = {
    volPulseOK: volOK,
    breakORH,
    nearOR,
    vwapReclaim: vwapRecl,
  };
  const signalCount = Object.values(signals).filter(Boolean).length;
  const armedMomentum = !!(aboveVWAP && signalCount >= 2);

  const dip = dipArmedNow({ candles, todayYMD: today, vwap: vwap ?? null });
  dbg.signals = {
    aboveVWAP, volPulse: vol?.mult ?? null, VOL_MULT_MIN,
    breakORH, nearOR, NEAR_OR_PCT, vwapReclaim: vwapRecl, VWAP_RECLAIM_BAND,
    signalCount, mSince930: m, armedMomentum, armedDip: dip.armed
  };
  dbg.dipMeta = dip.meta;

  const eligible = true;
  const armed = armedMomentum || dip.armed;

  return {
    eligible,
    armed,
    armedMomentum,
    armedDip: dip.armed,
    refPrice: last.close ?? null,
    meta: { dipMeta: dip.meta, vwap, orRange },
    debug: dbg,
  };
}

/** ───────────────── Order placement helper ───────────────── */
async function placeEntryNow(
  ticker: string,
  ref: number,
  state: any
): Promise<{ ok: boolean; shares?: number; reason?: string }> {
  const cashNum = Number(state!.cash);
  const shares = Math.floor(Math.min(cashNum, INVEST_BUDGET) / ref);
  if (shares <= 0) return { ok: false, reason: `insufficient_cash_for_one_share_ref_${ticker}_${ref.toFixed(2)}` };

  const tp = ref * (1 + TARGET_PCT);
  const sl = ref * (1 + STOP_PCT);

  try {
    const order = await submitBracketBuy({
      symbol: ticker,
      qty: shares,
      entryType: "market",
      tp,
      sl,
      tif: "day",
    });

    await prisma.position.create({
      data: { ticker, entryPrice: ref, shares, open: true, brokerOrderId: order.id },
    });

    await prisma.trade.create({
      data: { side: "BUY", ticker, price: ref, shares, brokerOrderId: order.id },
    });

    await prisma.botState.update({
      where: { id: 1 },
      data: { cash: cashNum - shares * ref, equity: cashNum - shares * ref + shares * ref },
    });

    return { ok: true, shares };
  } catch (e: any) {
    const msg = e?.message || "unknown";
    const body = e?.body ? JSON.stringify(e.body).slice(0, 300) : "";
    return { ok: false, reason: `alpaca_submit_failed_${ticker}:${msg}${body ? " body="+body : ""}` };
  }
}

/** ─────────── memos for runtime-only state ─────────── */
// Track that we already sold half once for a given ticker/day
const partialTPMemo: Record<string, { day: string; taken: boolean }> = {};
// Never lower SL: remember last pushed SL per ticker for the day
const lastDynSLMemo: Record<string, { day: string; sl: number }> = {};

/** ───────────────── Route handlers ───────────────── */
export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }

async function handle(req: Request) {
  const now = Date.now();

  if (pendingTick) {
    const data = await pendingTick;
    return NextResponse.json(data);
  }
  if (lastTickResponse && now - lastTickAt < MIN_TICK_MS) {
    return NextResponse.json(lastTickResponse);
  }

  pendingTick = (async () => {
    const debug: any = { reasons: [] as string[] };

    // Ensure state exists
    let state = await prisma.botState.findUnique({ where: { id: 1 } });
    if (!state) {
      state = await prisma.botState.create({
        data: { id: 1, cash: START_CASH, pnl: 0, equity: START_CASH },
      });
    }

    let openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
    let lastRec = await prisma.recommendation.findFirst({ orderBy: { id: "desc" } });
    let livePrice: number | null = null;

    // NEW: fetch real Alpaca balances for display
    let alpacaAccount: any = null;
    try {
      alpacaAccount = await getAccount();
    } catch {}

    const today = yyyyMmDdET();

    /** ── Mandatory exit after 15:55 ET ── */
    if (openPos && isMandatoryExitET()) {
      const exitTicker = openPos.ticker;
      try {
        await closePositionMarket(exitTicker);

        // ⬇️ Use cached quote for exit valuation
        const q = await fmpQuoteCached(exitTicker);
        const parsed = priceFromFmp(q);
        const p = parsed != null ? parsed : Number(openPos.entryPrice);

        const shares   = Number(openPos.shares);
        const entry    = Number(openPos.entryPrice);
        const exitVal  = shares * p;
        const realized = exitVal - shares * entry;

        await prisma.trade.create({ data: { side: "SELL", ticker: exitTicker, price: p, shares } });
        await prisma.position.update({ where: { id: openPos.id }, data: { open: false, exitPrice: p, exitAt: nowET() } });

        state = await prisma.botState.update({
          where: { id: 1 },
          data: {
            cash:   Number(state!.cash) + exitVal,
            pnl:    Number(state!.pnl) + realized,
            equity: Number(state!.cash) + exitVal,
          },
        });

        openPos = null;
        debug.lastMessage = `⏱️ Mandatory 15:55+ exit ${exitTicker}`;
      } catch {
        debug.reasons.push("mandatory_exit_exception");
      }
    }

    // Weekday & market gates
    if (!isWeekdayET()) {
      debug.reasons.push("not_weekday");
      return {
        state, lastRec, position: openPos, live: null,
        serverTimeET: nowET().toISOString(), skipped: "not_weekday",
        account: alpacaAccount,
        budget: { investPerTrade: INVEST_BUDGET },
        info: {
          prescan_0914_0929: inPreScanWindow(),
          scan_0930_0944: inScanWindow(),
          force_0945_0946: inForceWindow(),
          requireAiPick: REQUIRE_AI_PICK,
          targetPct: TARGET_PCT,
          stopPct: STOP_PCT,
          aiFreshnessMs: FRESHNESS_MS,
          liquidity: {
            minSharesAbs: MIN_SHARES_ABS,
            floatPctPerMin: FLOAT_MIN_PCT_PER_MIN,
            minDollarVol: MIN_DOLLAR_VOL,
          },
        },
        debug,
      };
    }
    const marketOpen = isMarketHoursET();

    /** ───────────────── Pre-SCAN 09:14–09:29 ───────────────── */
    if (!openPos && marketOpen && inPreScanWindow()) {
      const base = getBaseUrl(req);
      const snapshot = await getSnapshot(base);
      const top = (snapshot?.stocks || []).slice(0, TOP_CANDIDATES);
      const affordableTop = top.filter(s => Number.isFinite(Number(s.price)) && Number(s.price) <= INVEST_BUDGET);
      const candidates = affordableTop.length ? affordableTop : top;

      debug.presc_top = candidates.map((s) => s.ticker);

      try {
        const { primary, secondary, lastRecRow } =
          await ensureRollingRecommendationTwo(req, candidates);
        if (lastRecRow?.ticker) lastRec = lastRecRow;

        const picks = [primary, secondary].filter(Boolean) as string[];
        if (picks.length) {
          const { startISO, endISO } = premarketRangeISO(nowET());
          for (const sym of picks) {
            try {
              const bars = await getBars1m(sym, startISO, endISO);
              const pm = computePremarketLevelsFromBars(bars);
              if (pm) {
                scanMemo[sym] = { pmHigh: pm.pmHigh, pmLow: pm.pmLow, pmVol: pm.pmVol, fetchedAt: Date.now() };
              }
            } catch (e: any) {
              debug.reasons.push(`presc_pm_err_${sym}:${e?.message || "unknown"}`);
            }
          }
          debug.presc_pm_for = picks;
        } else {
          debug.reasons.push("presc_no_ai_picks_yet");
        }
      } catch (e: any) {
        debug.reasons.push(`presc_exception:${e?.message || "unknown"}`);
      }
    }

    /** ───────────────── 09:30–09:44 Scan Window (Dip prioritized across two picks) ───────────────── */
    if (!openPos && marketOpen && inScanWindow() && state!.lastRunDay !== today) {
      const base = getBaseUrl(req);
      let snapshot = await getSnapshot(base);
      let top = (snapshot?.stocks || []).slice(0, TOP_CANDIDATES);

      if (!top.length && lastGoodSnapshot && lastGoodSnapshotDay === today) {
        top = lastGoodSnapshot.stocks.slice(0, TOP_CANDIDATES);
        debug.used_last_good_snapshot_scan = true;
      }

      const affordableTop = top.filter(s => Number.isFinite(Number(s.price)) && Number(s.price) <= INVEST_BUDGET);
      const candidates = affordableTop.length ? affordableTop : top;

      debug.scan_top = candidates.map((s) => s.ticker);
      debug.scan_affordable_count = affordableTop.length;

      const { primary, secondary, lastRecRow } =
        await ensureRollingRecommendationTwo(req, candidates);
      if (!primary && REQUIRE_AI_PICK) {
        debug.reasons.push("scan_no_ai_pick_yet");
      } else {
        if (lastRecRow?.ticker) lastRec = lastRecRow;
        const picks = [primary, secondary].filter(Boolean) as string[];
        debug.scan_considered_order = picks;

        // Evaluate both first
        const evals: Record<string, Awaited<ReturnType<typeof evaluateEntrySignals>>> = {};
        for (const sym of picks) {
          evals[sym!] = await evaluateEntrySignals(sym!, snapshot, today);
        }
        debug.scan_evals = evals;

        // Choose preferred:
        // 1) Any with armedDip? Prefer that. If both, pick the one with larger pullbackPct.
        // 2) Else momentum: prefer primary if armedMomentum, else secondary if armedMomentum.
        let chosen: string | null = null;

        const dipArmed = picks
          .filter(s => evals[s]?.eligible && evals[s]?.armedDip)
          .sort((a, b) => {
            const pa = Number(evals[a]?.meta?.dipMeta?.pullbackPct ?? 0);
            const pb = Number(evals[b]?.meta?.dipMeta?.pullbackPct ?? 0);
            return pb - pa;
          });

        if (dipArmed.length) {
          chosen = dipArmed[0];
          debug.scan_choice_reason = `dip_armed_priority (${chosen})`;
        } else {
          const prim = picks[0];
          const sec  = picks[1];

          if (prim && evals[prim]?.eligible && evals[prim]?.armedMomentum) {
            chosen = prim;
            debug.scan_choice_reason = `primary_momentum (${chosen})`;
          } else if (sec && evals[sec]?.eligible && evals[sec]?.armedMomentum) {
            chosen = sec;
            debug.scan_choice_reason = `secondary_momentum (${chosen})`;
          }
        }

        if (chosen) {
          // Claim the day lock
          const claim = await prisma.botState.updateMany({
            where: { id: 1, OR: [{ lastRunDay: null }, { lastRunDay: { not: today } }] },
            data: { lastRunDay: today },
          });
          const claimed = claim.count === 1;
          if (!claimed) {
            debug.reasons.push("scan_day_lock_already_claimed");
          } else {
            const already = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
            if (already) {
              debug.reasons.push("scan_pos_open_after_claim");
            } else {
              // Resolve reference price
              let ref = evals[chosen]?.refPrice ?? null;
              if (ref == null || !Number.isFinite(Number(ref))) {
                ref = Number(snapshot?.stocks?.find((s) => s.ticker === chosen)?.price ?? NaN);
              }
              if (ref == null || !Number.isFinite(Number(ref))) {
                const q = await fmpQuoteCached(chosen);
                const p = priceFromFmp(q);
                if (p != null) ref = p;
              }
              if (ref != null && Number.isFinite(Number(ref))) {
                const placed = await placeEntryNow(chosen, Number(ref), state);
                if (placed.ok) {
                  debug.lastMessage = `✅ BUY (${evals[chosen]?.armedDip ? "Buy-the-Dip" : "Balanced setup"}) ${chosen} @ ~${Number(ref).toFixed(2)} (shares=${placed.shares})`;
                  openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
                } else {
                  debug.reasons.push(`scan_place_entry_failed_${chosen}:${placed.reason}`);
                  await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
                }
              } else {
                debug.reasons.push(`scan_no_price_for_entry_${chosen}`);
                await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
              }
            }
          }
        } else {
          debug.reasons.push("scan_no_armed_signal_after_eval");
        }
      }
    }

    /** ───────────────── 09:45–09:46 Force Window (unchanged) ───────────────── */
    if (!openPos && marketOpen && inForceWindow() && state!.lastRunDay !== today) {
      const base = getBaseUrl(req);
      let snapshot = await getSnapshot(base);
      let top = (snapshot?.stocks || []).slice(0, TOP_CANDIDATES);

      if (!top.length && lastGoodSnapshot && lastGoodSnapshotDay === today) {
        top = lastGoodSnapshot.stocks.slice(0, TOP_CANDIDATES);
        debug.used_last_good_snapshot_force = true;
      }

      const affordableTop = top.filter(s => Number.isFinite(Number(s.price)) && Number(s.price) <= INVEST_BUDGET);
      const candidates = affordableTop.length ? affordableTop : top;

      debug.force_top = candidates.map((s) => s.ticker);
      debug.force_affordable_count = affordableTop.length;

      const BURST_TRIES = 12;
      const BURST_DELAY_MS = 300;

      for (let i = 0; i < BURST_TRIES && !openPos; i++) {
        const { primary, secondary, lastRecRow } =
          await ensureRollingRecommendationTwo(req, candidates, 10_000);
        if (lastRecRow?.ticker) lastRec = lastRecRow;

        const picks = [primary, secondary].filter(Boolean) as string[];
        if (!picks.length) {
          debug.reasons.push(`force_no_ai_pick_iter_${i}`);
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }

        debug[`force_iter_${i}_picks`] = picks;

        let entered = false;
        for (const sym of picks) {
          // Resolve price
          let ref: number | null = Number(snapshot?.stocks?.find((s) => s.ticker === sym)?.price ?? NaN);
          if (!Number.isFinite(Number(ref))) {
            const q = await fmpQuoteCached(sym!);
            const p = priceFromFmp(q);
            if (p != null) ref = p;
          }
          if (ref == null || !Number.isFinite(Number(ref))) {
            debug.reasons.push(`force_no_price_for_entry_${sym}`);
            continue;
          }

          if (ref < PRICE_MIN || ref > PRICE_MAX) {
            debug.reasons.push(`force_price_band_fail_${sym}_${ref.toFixed(2)}`);
            continue;
          }
          const spreadLimit = dynamicSpreadLimitPct(nowET(), ref ?? null, "force");
          const spreadOK = await spreadGuardOK(sym!, spreadLimit);
          if (!spreadOK) {
            debug.reasons.push(`force_spread_guard_fail_${sym}_limit=${(spreadLimit*100).toFixed(2)}%`);
            continue;
          }

          const claim = await prisma.botState.updateMany({
            where: { id: 1, OR: [{ lastRunDay: null }, { lastRunDay: { not: yyyyMmDdET() } }] },
            data: { lastRunDay: yyyyMmDdET() },
          });
          const claimed = claim.count === 1;
          if (!claimed) continue;

          const already = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
          if (already) continue;

          const placed = await placeEntryNow(sym!, Number(ref), state!);
          if (placed.ok) {
            debug.lastMessage = `✅ 09:45 FORCE BUY (guards ok) ${sym} @ ~${Number(ref).toFixed(2)} (shares=${placed.shares})`;
            openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
            entered = true;
            break;
          } else {
            debug.reasons.push(`force_place_entry_failed_${sym}:${placed.reason}`);
            await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
          }
        }
        if (entered) break;
        await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
      }
    }

    /** ── End-of-force failsafe: clear stuck lock ── */
    if (!openPos && inEndOfForceFailsafe()) {
      if (state!.lastRunDay === yyyyMmDdET()) {
        await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
        (debug.reasons as string[]).push("force_failsafe_cleared_day_lock");
      }
    }

    /** ───────────────── Holding: refresh equity + partial TP + ratchet ───────────────── */
    if (openPos) {
      const q = await fmpQuoteCached(openPos.ticker);
      const pParsed = priceFromFmp(q);
      if (pParsed != null) {
        const p = pParsed;
        livePrice = p;

        const equityNow = Number(state!.cash) + Number(openPos.shares) * p;
        if (Number(state!.equity) !== equityNow) {
          state = await prisma.botState.update({ where: { id: 1 }, data: { equity: equityNow } });
        }

        try {
          const todayYMD = yyyyMmDdET();
          const candles = await fetchCandles1m(openPos.ticker, 240);
          const day = candles.filter((c) => isSameETDay(toET(c.date), todayYMD));

          if (day.length >= 2) {
            const prior = day.slice(0, -1);
            const dayHigh = Math.max(...prior.map((c) => c.high));

            const entry = Number(openPos.entryPrice);
            const rat = computeRatchetTargets(entry, dayHigh);

            // ── Try partial take-profit once at +10% from entry ──
            const baseTP = Math.round(entry * (1 + TARGET_PCT) * 100) / 100;
            const memoKey = `${openPos.ticker}:${todayYMD}`;
            const alreadyTookHalf = partialTPMemo[memoKey]?.taken === true && partialTPMemo[memoKey].day === todayYMD;

            if (!alreadyTookHalf && p >= baseTP) {
              const half = Math.floor(Number(openPos.shares) / 2);
              if (half >= 1) {
                try {
                  await sellMarket({ symbol: openPos.ticker, qty: half }); // real broker sell half

                  const realized = half * (p - entry);
                  const exitVal  = half * p;
                  // Record trade + shrink open position shares (keep it open)
                  await prisma.trade.create({ data: { side: "SELL", ticker: openPos.ticker, price: p, shares: half } });
                  await prisma.position.update({
                    where: { id: openPos.id },
                    data: { shares: Number(openPos.shares) - half }
                  });

                  // Update state
                  state = await prisma.botState.update({
                    where: { id: 1 },
                    data: {
                      cash:   Number(state!.cash) + exitVal,
                      pnl:    Number(state!.pnl) + realized,
                      equity: Number(state!.cash) + exitVal + (Number(openPos.shares) - half) * p,
                    },
                  });

                  // Mark memo
                  partialTPMemo[memoKey] = { day: todayYMD, taken: true };
                  debug.partialTP = { tookHalfAt: p, baseTP, halfQty: half };
                  // Refresh local openPos snapshot for the rest of this tick
                  openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });

                  // Optional: lift remaining children to current dyn targets (if any)
                  if (rat && RATCHET_LIFT_BROKER_CHILDREN && openPos) {
                    const prev = lastDynSLMemo[memoKey]?.sl ?? rat.initialSL;
                    const monotonicSL = Math.max(prev, rat.dynSL);
                    try {
                      await replaceTpSlIfBetter({
                        symbol: openPos.ticker,
                        newTp: rat.dynTP,
                        newSl: monotonicSL,
                      });
                      lastDynSLMemo[memoKey] = { day: todayYMD, sl: monotonicSL };
                    } catch {}
                  }
                } catch (e: any) {
                  debug.reasons.push(`partial_tp_sell_exception:${e?.message || "unknown"}`);
                }
              }
            }

            // ── Ratchet trailing for the remaining shares ──
            if (rat && openPos) {
              // Never lower SL (monotonic)
              const prevSL = lastDynSLMemo[memoKey]?.sl ?? rat.initialSL;
              const monotonicSL = Math.max(prevSL, rat.dynSL);
              lastDynSLMemo[memoKey] = { day: todayYMD, sl: monotonicSL };

              debug.ratchet = {
                steps: rat.steps,
                dayHigh: Math.round(dayHigh * 100) / 100,
                dynSL: monotonicSL,
                dynTP: rat.dynTP
              };

              if (RATCHET_LIFT_BROKER_CHILDREN) {
                const key = openPos.ticker;
                const memo = ratchetLiftMemo[key] || { lastStep: -1, lastLiftAt: 0 };
                const nowTs = Date.now();

                if (rat.steps > memo.lastStep && (nowTs - memo.lastLiftAt) >= LIFT_COOLDOWN_MS) {
                  try {
                    const replaced = await replaceTpSlIfBetter({
                      symbol: key,
                      newTp: rat.dynTP,
                      newSl: monotonicSL,
                    });
                    ratchetLiftMemo[key] = { lastStep: rat.steps, lastLiftAt: nowTs };
                    debug.ratchet_replace = { step: rat.steps, ...replaced, cooldownMs: LIFT_COOLDOWN_MS };
                  } catch (e: any) {
                    debug.reasons.push(`ratchet_replace_children_exception:${e?.message || "unknown"}`);
                  }
                } else {
                  debug.ratchet_replace_skipped = {
                    reason: rat.steps <= memo.lastStep ? "no_new_step" : "cooldown",
                    lastStep: memo.lastStep,
                    lastLiftAgoMs: nowTs - memo.lastLiftAt,
                    cooldownMs: LIFT_COOLDOWN_MS,
                  };
                }
              }

              // Virtual exits for what remains
              if (RATCHET_VIRTUAL_EXITS && openPos) {
                if (p >= rat.dynTP) {
                  const exitTicker = openPos.ticker;
                  try {
                    const shares = Number(openPos.shares);
                    const entry  = Number(openPos.entryPrice);
                    await closePositionMarket(exitTicker);

                    const exitVal  = shares * p;
                    const realized = exitVal - shares * entry;

                    await prisma.trade.create({ data: { side: "SELL", ticker: exitTicker, price: p, shares } });
                    await prisma.position.update({ where: { id: openPos.id }, data: { open: false, exitPrice: p, exitAt: nowET() } });

                    state = await prisma.botState.update({
                      where: { id: 1 },
                      data: {
                        cash:   Number(state!.cash) + exitVal,
                        pnl:    Number(state!.pnl) + realized,
                        equity: Number(state!.cash) + exitVal,
                      },
                    });

                    debug.lastMessage = `🏁 Ratchet TP hit ${exitTicker} @ ${p.toFixed(2)} (dynTP=${rat.dynTP.toFixed(2)})`;
                    openPos = null;
                  } catch (e: any) {
                    debug.reasons.push(`ratchet_tp_close_exception:${e?.message || "unknown"}`);
                  }
                } else if (p <= lastDynSLMemo[memoKey]?.sl /* monotonic SL */) {
                  const exitTicker = openPos.ticker;
                  try {
                    const shares = Number(openPos.shares);
                    const entry  = Number(openPos.entryPrice);
                    await closePositionMarket(exitTicker);

                    const exitVal  = shares * p;
                    const realized = exitVal - shares * entry;

                    await prisma.trade.create({ data: { side: "SELL", ticker: exitTicker, price: p, shares } });
                    await prisma.position.update({ where: { id: openPos.id }, data: { open: false, exitPrice: p, exitAt: nowET() } });

                    state = await prisma.botState.update({
                      where: { id: 1 },
                      data: {
                        cash:   Number(state!.cash) + exitVal,
                        pnl:    Number(state!.pnl) + realized,
                        equity: Number(state!.cash) + exitVal,
                      },
                    });

                    debug.lastMessage = `🛡️ Ratchet SL hit ${exitTicker} @ ${p.toFixed(2)} (dynSL=${(lastDynSLMemo[memoKey]?.sl || 0).toFixed(2)})`;
                    openPos = null;
                  } catch (e: any) {
                    debug.reasons.push(`ratchet_sl_close_exception:${e?.message || "unknown"}`);
                  }
                }
              }
            }
          }
        } catch (e: any) {
          debug.reasons.push(`hold_calc_exception:${e?.message || "unknown"}`);
        }
      }
    } else if (lastRec?.ticker) {
      const q = await fmpQuoteCached(lastRec.ticker);
      const p = priceFromFmp(q);
      if (p != null) livePrice = p;
    }

    return {
      state,
      lastRec,
      position: openPos,
      live: { ticker: openPos?.ticker ?? lastRec?.ticker ?? null, price: livePrice },
      serverTimeET: nowET().toISOString(),
      account: alpacaAccount,
      budget: { investPerTrade: INVEST_BUDGET },
      info: {
        prescan_0914_0929: inPreScanWindow(),
        scan_0930_0944: inScanWindow(),
        force_0945_0946: inForceWindow(),
        requireAiPick: REQUIRE_AI_PICK,
        targetPct: TARGET_PCT,
        stopPct: STOP_PCT,
        aiFreshnessMs: FRESHNESS_MS,
        liquidity: {
          minSharesAbs: MIN_SHARES_ABS,
          floatPctPerMin: FLOAT_MIN_PCT_PER_MIN,
          minDollarVol: MIN_DOLLAR_VOL,
        },
      },
      debug,
    };
  })();

  try {
    const data = await pendingTick;
    lastTickAt = Date.now();
    lastTickResponse = data;
    return NextResponse.json(data);
  } finally {
    pendingTick = null;
  }
}
