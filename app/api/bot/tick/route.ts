// app/api/bot/tick/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getQuote } from "@/lib/quote";
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
} from "@/lib/alpaca";

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

// Ratchet config (unchanged)
const RATCHET_ENABLED = true;
const RATCHET_STEP_PCT = 0.05;
const RATCHET_LIFT_BROKER_CHILDREN = true;
const RATCHET_VIRTUAL_EXITS = true;

// Alpaca TP/SL lift cooldown
const LIFT_COOLDOWN_MS = 6000;
const ratchetLiftMemo: Record<string, { lastStep: number; lastLiftAt: number }> = {};

// ── Balanced profile (time-decayed thresholds across 9:30–10:14) ──
const DECAY_START_MIN = 0;    // at 9:30 (inclusive)
const DECAY_END_MIN   = 44;   // at 10:14 (inclusive)

// Volume pulse: 1.20x → 1.10x
const VOL_MULT_START = 1.20;
const VOL_MULT_END   = 1.10;

// Near-OR tolerance: 0.30% → 0.45%
const NEAR_OR_START  = 0.003;
const NEAR_OR_END    = 0.0045;

// VWAP reclaim band: 0.20% → 0.30%
const VWAP_BAND_START = 0.002;
const VWAP_BAND_END   = 0.003;

// Execution guards (fixed)
const SPREAD_MAX_PCT = 0.005;  // 0.50%
const MIN_1M_VOL     = 30_000; // last bar
const PRICE_MIN = 1;
const PRICE_MAX = 70;

// AI pick freshness
const FRESHNESS_MS = 30_000;

// Require AI pick (true = don't fallback to top-1, except in FORCE window)
const REQUIRE_AI_PICK = true;

/** ───────────────── Time Windows (ET) ─────────────────
 * Pre-scan: 09:14:00–09:29:59 (premarket levels from Alpaca)
 * Scan    : 09:30:00–10:14:59 (setup must arm to buy)
 * Force   : 10:15:00–10:16:59 (buy AI pick regardless of setup, with guards)
 * Exit    : 15:55+
 */
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
  return m >= 9 * 60 + 30 && m <= 10 * 60 + 14 && s <= 59;
}
function inForceWindow() {
  const d = nowET();
  return d.getHours() === 10 && (d.getMinutes() === 15 || d.getMinutes() === 16);
}
function inEndOfForceFailsafe() {
  const d = nowET();
  return d.getHours() === 10 && d.getMinutes() === 16 && d.getSeconds() >= 30;
}
function isMandatoryExitET() {
  const d = nowET();
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= (15 * 60 + 55);
}

/** ───────────────── Types & Helpers ───────────────── */
type SnapStock = {
  ticker: string;
  price?: number | null;
  changesPercentage?: number | null;
  volume?: number | null;
  avgVolume?: number | null;
  marketCap?: number | null;
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

/** ─────────── AI pick parsers (now returns up to TWO picks) ─────────── */
function tokenizeTickers(txt: string): string[] {
  if (!txt) return [];
  return Array.from(new Set((txt.toUpperCase().match(/\b[A-Z]{1,5}\b/g) || [])));
}
function parseTwoPicksFromResponse(rJson: any, allowed?: string[]): string[] {
  const allowSet = new Set((allowed || []).map(s => s.toUpperCase()));
  const out: string[] = [];

  // 1) explicit array: rJson.picks = ["AAA","BBB"]
  if (Array.isArray(rJson?.picks)) {
    for (const s of rJson.picks) {
      const u = String(s || "").toUpperCase();
      if (/^[A-Z][A-Z0-9.\-]*$/.test(u) && (!allowSet.size || allowSet.has(u))) out.push(u);
      if (out.length >= 2) return out;
    }
  }

  // 2) dedicated fields / common keys
  const fields = [
    rJson?.ticker, rJson?.symbol, rJson?.pick, rJson?.Pick,
    rJson?.data?.ticker, rJson?.data?.symbol,
  ];
  for (const f of fields) {
    const u = typeof f === "string" ? f.toUpperCase() : "";
    if (/^[A-Z][A-Z0-9.\-]*$/.test(u) && (!allowSet.size || allowSet.has(u)) && !out.includes(u)) out.push(u);
    if (out.length >= 2) return out;
  }

  // 3) parse text for "Pick:" and "Second"
  let txt = String(rJson?.recommendation ?? rJson?.text ?? rJson?.message ?? "");
  txt = txt.replace(/[*_`~]/g, "").replace(/^-+\s*/gm, "");
  const m1 = /Pick\s*:?\s*([A-Z][A-Z0-9.\-]*)/i.exec(txt);
  const m2 = /Second[^A-Za-z0-9]{0,6}choice[^A-Za-z0-9]{0,6}:?\s*([A-Z][A-Z0-9.\-]*)/i.exec(txt);
  const cands = [m1?.[1], m2?.[1]].filter(Boolean).map(s => String(s).toUpperCase());
  for (const c of cands) {
    if ((!allowSet.size || allowSet.has(c)) && !out.includes(c)) out.push(c);
    if (out.length >= 2) return out;
  }

  // 4) generic tokens; intersect with allowed, take first 2
  const toks = tokenizeTickers(txt).filter(t => !allowSet.size || allowSet.has(t));
  for (const t of toks) {
    if (!out.includes(t)) out.push(t);
    if (out.length >= 2) break;
  }
  return out;
}

/** Fetch/refresh recommendation and return up to two picks.
 * Also persists PRIMARY pick to prisma.recommendation (for UI/back-compat).
 */
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

  // Always (re)fetch if stale/not-today/not-top to get possibly two picks
  let primary: string | null = lastRec?.ticker ?? null;
  let secondary: string | null = null;

  if (tooOld || notToday || notInTop) {
    const base = getBaseUrl(req);
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
        const picks = parseTwoPicksFromResponse(rJson, allowed); // up to 2
        if (picks.length) {
          primary = picks[0] || null;
          secondary = picks[1] || null;

          // try to resolve a ref price for the primary (for DB/UI)
          let ref: number | null =
            Number(topStocks.find((s) => s.ticker === primary)?.price ?? NaN);
          if (!Number.isFinite(Number(ref))) {
            const q = await getQuote(primary!);
            if (q != null && Number.isFinite(Number(q))) ref = Number(q);
          }
          const priceNum = Number.isFinite(Number(ref)) ? Number(ref) : null;

          // 🔧 IMPORTANT: only include 'price' when finite
          const data: any = { ticker: primary! };
          if (typeof priceNum === "number" && Number.isFinite(priceNum)) {
            data.price = priceNum;
          }
          lastRec = await prisma.recommendation.create({ data });
        }
      }
    } catch {
      // ignore fetch errors; fall back to previous row if any
    }
  } else {
    // lastRec fresh; still try to extract a secondary if we can
    const base = getBaseUrl(req);
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
        }
      }
    } catch {
      // ignore
    }
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
  // Balanced: tighter OR window 9:30–9:33
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
function computeDayHighSoFar(candles: Candle[], todayYMD: string) {
  const day = candles.filter((c) => isSameETDay(toET(c.date), todayYMD));
  if (day.length < 2) return null;
  const prior = day.slice(0, -1);
  return Math.max(...prior.map((c) => c.high));
}
function brokeRecentHighs(candles: Candle[], todayYMD: string, n = 3) {
  const day = candles.filter((c) => isSameETDay(toET(c.date), todayYMD));
  if (day.length < n + 1) return false;
  const last  = day[day.length - 1];
  const prior = day.slice(-1 - n, -1);
  const priorMax = Math.max(...prior.map((c) => c.high));
  return last.close > priorMax;
}

/** Ratcheting targets */
function computeRatchetTargets(entry: number, dayHighSinceOpen: number) {
  if (!RATCHET_ENABLED) return null;
  if (!Number.isFinite(entry) || !Number.isFinite(dayHighSinceOpen) || entry <= 0) return null;
  const upFromEntry = dayHighSinceOpen / entry - 1;
  const step = Math.max(0.0001, RATCHET_STEP_PCT);
  const steps = Math.max(0, Math.floor(upFromEntry / step));
  const factor = Math.pow(1 + step, steps);
  const initialSL = entry * (1 + STOP_PCT);
  const initialTP = entry * (1 + TARGET_PCT);
  const dynSL = initialSL * factor;
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

/** ── Balanced profile decay helpers ── */
function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function minutesSince930ET() {
  const d = nowET();
  const mins = d.getHours() * 60 + d.getMinutes();
  const t = mins - (9 * 60 + 30);
  return Math.max(0, Math.min(44, t));
}

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

    const today = yyyyMmDdET();

    /** ── Mandatory exit after 15:55 ET ── */
    if (openPos && isMandatoryExitET()) {
      const exitTicker = openPos.ticker;
      try {
        await closePositionMarket(exitTicker);

        const pQuote = await getQuote(exitTicker);
        const p = (pQuote != null && Number.isFinite(Number(pQuote)))
          ? Number(pQuote)
          : Number(openPos.entryPrice);

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
        serverTimeET: nowET().toISOString(), skipped: "not_weekday", debug,
      };
    }
    const marketOpen = isMarketHoursET();

    /** ───────────────── Pre-SCAN 09:14–09:29 (premarket levels from Alpaca) ───────────────── */
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

    /** helper: evaluate one ticker and maybe enter; returns true if we entered (to stop the loop) */
    const evalAndMaybeEnter = async (ticker: string, snapshot: { stocks: SnapStock[] } | null, today: string): Promise<boolean> => {
      try {
        const candles = await fetchCandles1m(ticker, 240);
        const day = candles.filter((c) => isSameETDay(toET(c.date), today));
        if (!day.length) {
          debug.reasons.push(`scan_no_day_candles_${ticker}`);
          return false;
        }
        const last = day[day.length - 1];

        // Exec guards
        if (last.close < PRICE_MIN || last.close > PRICE_MAX) {
          debug.reasons.push(`scan_price_band_fail_${ticker}_${last.close.toFixed(2)}`);
          return false;
        }
        if ((last.volume ?? 0) < MIN_1M_VOL) {
          debug.reasons.push(`scan_min_1m_vol_fail_${ticker}_${last.volume ?? 0}`);
          return false;
        }
        const spreadOK = await spreadGuardOK(ticker, SPREAD_MAX_PCT);
        if (!spreadOK) {
          debug.reasons.push(`scan_spread_guard_fail_${ticker}`);
          return false;
        }

        // Decayed thresholds
        const m = minutesSince930ET();
        const t = clamp01((m - DECAY_START_MIN) / (DECAY_END_MIN - DECAY_START_MIN));
        const VOL_MULT_MIN = lerp(VOL_MULT_START, VOL_MULT_END, t);
        const NEAR_OR_PCT  = lerp(NEAR_OR_START,  NEAR_OR_END,  t);
        const VWAP_RECLAIM_BAND = lerp(VWAP_BAND_START, VWAP_BAND_END, t);

        const orRange = computeOpeningRange(candles, today);
        const vwap    = computeSessionVWAP(candles, today);
        const vol     = computeVolumePulse(candles, today, 5);
        const dayHigh = computeDayHighSoFar(candles, today);

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
        const armed = !!(aboveVWAP && signalCount >= 2);

        const memo = scanMemo[ticker];
        if (memo) {
          debug[`scan_pm_ctx_${ticker}`] = { pmHigh: memo.pmHigh, pmLow: memo.pmLow, pmVol: memo.pmVol };
        }
        debug[`scan_signals_${ticker}`] = {
          aboveVWAP, volPulse: vol?.mult ?? null, VOL_MULT_MIN,
          breakORH, nearOR, NEAR_OR_PCT, vwapRecl, VWAP_RECLAIM_BAND,
          signalCount, mSince930: m
        };

        if (!armed) return false;

        // Claim the day lock
        const claim = await prisma.botState.updateMany({
          where: { id: 1, OR: [{ lastRunDay: null }, { lastRunDay: { not: today } }] },
          data: { lastRunDay: today },
        });
        const claimed = claim.count === 1;
        if (!claimed) {
          debug.reasons.push("scan_day_lock_already_claimed");
          return false;
        }

        // Re-check no position
        const already = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
        if (already) {
          debug.reasons.push("scan_pos_open_after_claim");
          return false;
        }

        // Reference price
        let ref: number | null =
          Number(snapshot?.stocks?.find((s) => s.ticker === ticker)?.price ?? NaN);
        if (!Number.isFinite(Number(ref))) {
          const q = await getQuote(ticker);
          if (q != null && Number.isFinite(Number(q))) ref = Number(q);
        }
        if (ref == null || !Number.isFinite(Number(ref))) {
          debug.reasons.push(`scan_no_price_for_entry_${ticker}`);
          await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
          return false;
        }

        const cashNum = Number(state!.cash);
        const shares = Math.floor(Math.min(cashNum, INVEST_BUDGET) / ref);
        if (shares <= 0) {
          debug.reasons.push(`scan_insufficient_cash_for_one_share_ref_${ticker}_${ref.toFixed(2)}`);
          await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
          return false;
        }

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

          const pos = await prisma.position.create({
            data: { ticker, entryPrice: ref, shares, open: true, brokerOrderId: order.id },
          });

          await prisma.trade.create({
            data: { side: "BUY", ticker, price: ref, shares, brokerOrderId: order.id },
          });

          await prisma.botState.update({
            where: { id: 1 },
            data: { cash: cashNum - shares * ref, equity: cashNum - shares * ref + shares * ref },
          });

          debug.lastMessage = `✅ BUY (Balanced setup) ${ticker} @ ~${ref.toFixed(2)} (shares=${shares})`;
          return true; // <<< STOP after first successful entry
        } catch (e: any) {
          const msg = e?.message || "unknown";
          const body = e?.body ? JSON.stringify(e.body).slice(0, 300) : "";
          debug.reasons.push(`scan_alpaca_submit_failed_${ticker}:${msg}${body ? " body="+body : ""}`);
          await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
          return false;
        }
      } catch (e: any) {
        const msg = e?.message || "unknown";
        if (!/price_band_fail|min_vol_fail|spread_guard_fail/.test(msg)) {
          debug.reasons.push(`scan_signal_exception_${ticker}:${msg}`);
        }
        return false;
      }
    };

    /** ───────────────── 09:30–10:14 Scan Window (Balanced profile) ───────────────── */
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

        for (const sym of picks) {
          const entered = await evalAndMaybeEnter(sym, snapshot, today);
          if (entered) { openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } }); break; }
        }
        if (!openPos) debug.reasons.push("scan_signals_not_armed_or_no_entry");
      }
    }

    /** helper: try one ticker in the FORCE window (returns true if entered) */
    const tryOneForce = async (ticker: string, snapshot: { stocks: SnapStock[] } | null): Promise<boolean> => {
      const spreadOK = await spreadGuardOK(ticker, SPREAD_MAX_PCT);
      if (!spreadOK) {
        debug.reasons.push(`force_spread_guard_fail_${ticker}`);
        return false;
      }

      // Resolve price for sizing & band check
      let ref: number | null =
        Number(snapshot?.stocks?.find((s) => s.ticker === ticker)?.price ?? NaN);
      if (!Number.isFinite(Number(ref))) {
        const q = await getQuote(ticker);
        if (q != null && Number.isFinite(Number(q))) ref = Number(q);
      }
      if (ref == null || !Number.isFinite(Number(ref))) {
        debug.reasons.push(`force_no_price_for_entry_${ticker}`);
        return false;
      }
      if (ref < PRICE_MIN || ref > PRICE_MAX) {
        debug.reasons.push(`force_price_band_fail_${ticker}_${ref.toFixed(2)}`);
        return false;
      }

      // Claim day lock
      const claim = await prisma.botState.updateMany({
        where: { id: 1, OR: [{ lastRunDay: null }, { lastRunDay: { not: yyyyMmDdET() } }] },
        data: { lastRunDay: yyyyMmDdET() },
      });
      const claimed = claim.count === 1;
      if (!claimed) return false;

      const already = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
      if (already) return false;

      const cashNum = Number(state!.cash);
      const shares = Math.floor(Math.min(cashNum, INVEST_BUDGET) / ref);
      if (shares <= 0) {
        debug.reasons.push(`force_insufficient_cash_for_one_share_ref_${ticker}_${ref.toFixed(2)}`);
        await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
        return false;
      }

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

        const pos = await prisma.position.create({
          data: { ticker, entryPrice: ref, shares, open: true, brokerOrderId: order.id },
        });

        await prisma.trade.create({
          data: { side: "BUY", ticker, price: ref, shares, brokerOrderId: order.id },
        });

        await prisma.botState.update({
          where: { id: 1 },
          data: { cash: cashNum - shares * ref, equity: cashNum - shares * ref + shares * ref },
        });

        debug.lastMessage = `✅ 10:15 FORCE BUY (guards ok) ${ticker} @ ~${ref.toFixed(2)} (shares=${shares})`;
        return true; // <<< STOP after first force entry
      } catch (e: any) {
        const msg = e?.message || "unknown";
        const body = e?.body ? JSON.stringify(e.body).slice(0, 300) : "";
        debug.reasons.push(`force_alpaca_submit_failed_${ticker}:${msg}${body ? " body="+body : ""}`);
        await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
        return false;
      }
    };

    /** ───────────────── 10:15–10:16 Force Window ───────────────── */
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

      // burst loop unchanged, but we’ll try BOTH picks per iteration and stop after the first that enters
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
          entered = await tryOneForce(sym, snapshot);
          if (entered) break; // <<< only one trade/day
        }
        if (entered) {
          openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
          break;
        }

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

    /** ───────────────── Holding: refresh equity for UI + ratchet stop/TP ───────────────── */
    if (openPos) {
      const q = await getQuote(openPos.ticker);
      if (q != null && Number.isFinite(Number(q))) {
        const p = Number(q);
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

            const rat = computeRatchetTargets(Number(openPos.entryPrice), dayHigh);
            if (rat) {
              debug.ratchet = {
                steps: rat.steps,
                dayHigh: Math.round(dayHigh * 100) / 100,
                dynSL: rat.dynSL,
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
                      newSl: rat.dynSL,
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

              if (RATCHET_VIRTUAL_EXITS) {
                if (p >= rat.dynTP) {
                  const exitTicker = openPos.ticker;
                  try {
                    await closePositionMarket(exitTicker);

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

                    debug.lastMessage = `🏁 Ratchet TP hit ${exitTicker} @ ${p.toFixed(2)} (dynTP=${rat.dynTP.toFixed(2)})`;
                    openPos = null;
                  } catch (e: any) {
                    debug.reasons.push(`ratchet_tp_close_exception:${e?.message || "unknown"}`);
                  }
                } else if (p <= rat.dynSL) {
                  const exitTicker = openPos.ticker;
                  try {
                    await closePositionMarket(exitTicker);

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

                    debug.lastMessage = `🛡️ Ratchet SL hit ${exitTicker} @ ${p.toFixed(2)} (dynSL=${rat.dynSL.toFixed(2)})`;
                    openPos = null;
                  } catch (e: any) {
                    debug.reasons.push(`ratchet_sl_close_exception:${e?.message || "unknown"}`);
                  }
                }
              }
            }
          }
        } catch (e: any) {
          debug.reasons.push(`ratchet_calc_exception:${e?.message || "unknown"}`);
        }
      }
    } else if (lastRec?.ticker) {
      const q = await getQuote(lastRec.ticker);
      if (q != null && Number.isFinite(Number(q))) livePrice = Number(q);
    }

    return {
      state,
      lastRec,
      position: openPos,
      live: { ticker: openPos?.ticker ?? lastRec?.ticker ?? null, price: livePrice },
      serverTimeET: nowET().toISOString(),
      info: {
        prescan_0914_0929: inPreScanWindow(),
        scan_0930_1014: inScanWindow(),
        force_1015_1016: inForceWindow(),
        requireAiPick: REQUIRE_AI_PICK,
        targetPct: TARGET_PCT,
        stopPct: STOP_PCT,
        aiFreshnessMs: FRESHNESS_MS,
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
