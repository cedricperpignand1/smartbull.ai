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
  getPosition,
  getBars1m,
  premarketRangeISO,
  computePremarketLevelsFromBars,
  spreadGuardOK,
  getAccount,
  sellMarket,
} from "@/lib/alpaca";

// ✅ Cached FMP helpers
import { fmpQuoteCached } from "../../../../lib/fmpCached";

/* -------------------------- sizing tiers -------------------------- */
const SIZE_FULL = 1.0;  // default
const SIZE_HALF = 0.75; // requested mid tier
const SIZE_MICRO = 0.50; // smaller tier

/* -------------------------- throttle & config -------------------------- */
let lastTickAt = 0;
let lastTickResponse: any = null;
let pendingTick: Promise<any> | null = null;
const MIN_TICK_MS = 200;

const START_CASH = 4000;
const INVEST_BUDGET = 4000;

// NOTE: TARGET_PCT is still 10% as the "strong" default.
// For weak setups we override per-trade TP to 5% (see placeEntryNow()).
const TARGET_PCT = 0.10;   // strong TP default (+10% from fill)
const STOP_PCT = -0.05;    // SL -5% from fill
const TOP_CANDIDATES = 8;

/** ENABLE the staircase ratchet (only raises stop) */
const RATCHET_ENABLED = true;

/** 5% staircase: +5% → BE, +10% → +5%, +15% → +10%, ... */
const RATCHET_STEP_PCT = 0.05;

/** We lift the broker OCO stop child in-place (no virtual exits) */
const RATCHET_LIFT_BROKER_CHILDREN = true;
const RATCHET_VIRTUAL_EXITS = false;

/** Cooldown between lifts to avoid thrash (ms) */
const LIFT_COOLDOWN_MS = 12000;

/** Max tightness: never place stop tighter than 5% below high-water */
const MAX_TIGHTNESS_BEHIND_HIGH = 0.05;

/** Require at least 2 cents improvement before lifting */
const MIN_SL_IMPROVE_CENTS = 0.02;

/** legacy ratchet memory (not used) */
const ratchetLiftMemo: Record<string, { lastStep: number; lastLiftAt: number }> = {};

/* -------------------------- dynamic thresholds -------------------------- */
const DECAY_START_MIN = 0;
const DECAY_END_MIN = 14;

const VOL_MULT_START = 1.20;
const VOL_MULT_END = 1.10;

const NEAR_OR_START = 0.003;
const NEAR_OR_END = 0.0045;

const VWAP_BAND_START = 0.002;
const VWAP_BAND_END = 0.003;

const PRICE_MIN = 1;
const PRICE_MAX = 70;

const FRESHNESS_MS = 30_000;
const REQUIRE_AI_PICK = true;

/* ====================== RELAXED LIQUIDITY: tuned for low-floats ====================== */
const MIN_SHARES_ABS = 3_000;
const FLOAT_MIN_PCT_PER_MIN = 0.001;
const MIN_DOLLAR_VOL = 75_000;
/* ===================================================================================== */

/* -------------------------- Buy-the-Dip constants -------------------------- */
const DIP_MIN_PCT = 0.07;          // 7% pullback from 9:30 open
const DIP_MAX_PCT = 0.20;          // up to 20% pullback
const DIP_CONFIRM_EITHER = true;   // either prior-high break OR VWAP reclaim is enough

/* -------------------------- spread/account memo -------------------------- */
const SPREAD_TTL_MS = 1200;  // reuse spread result ~1.2s
const ACCOUNT_TTL_MS = 3000; // reuse account snapshot ~3s

const _spreadMemo = new Map<string, { t: number; v: boolean }>();
async function memoSpreadGuardOK(symbol: string, limitPct: number) {
  const key = `${symbol}|${limitPct.toFixed(4)}`;
  const now = Date.now();
  const hit = _spreadMemo.get(key);
  if (hit && now - hit.t < SPREAD_TTL_MS) return hit.v;
  const v = await spreadGuardOK(symbol, limitPct);
  _spreadMemo.set(key, { t: now, v });
  return v;
}

let _acctMemo: { t: number; v: any } | null = null;
async function memoGetAccount() {
  const now = Date.now();
  if (_acctMemo && now - _acctMemo.t < ACCOUNT_TTL_MS) return _acctMemo.v;
  const v = await getAccount();
  _acctMemo = { t: now, v };
  return v;
}

/* -------------------------- AI fallback controls (NEW) -------------------------- */
const AI_FALLBACK_ENABLED = true;
// Allow fallback only late in scan window to give AI a chance first
const AI_FALLBACK_MINUTE_FROM_OPEN = 8; // 9:38 ET (8 minutes after 9:30)
function allowAIFallbackNow() {
  const m = minutesSince930ET();
  return m >= AI_FALLBACK_MINUTE_FROM_OPEN && m <= 14; // 9:38–9:44
}

/* -------------------------- helpers -------------------------- */
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

function priceFromFmp(q: any): number | null {
  const n = Number(q?.price ?? q?.c ?? q?.close ?? q?.previousClose);
  return Number.isFinite(n) ? n : null;
}
function round2(x: number) { return Math.round(x * 100) / 100; }

function getBaseUrl(req: Request) {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = (req.headers.get("x-forwarded-proto") || "http").split(",")[0].trim();
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim();
  return `${proto}://${host}`;
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

/* -------------------------- time windows -------------------------- */
function inPreScanWindow() {
  const d = nowET(); const mins = d.getHours() * 60 + d.getMinutes(); const s = d.getSeconds();
  return mins >= 9 * 60 + 14 && mins <= 9 * 60 + 29 && s <= 59;
}
function inScanWindow() {
  const d = nowET(); const m = d.getHours() * 60 + d.getMinutes(); const s = d.getSeconds();
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
/** Mandatory exit from 15:50 ET onward */
function isMandatoryExitET() {
  const d = nowET();
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= (15 * 60 + 50);
}

/* >>>>>>>>>>>>>>> helper for early spread <<<<<<<<<<<<<<< */
function inWindow930to945ET() {
  const d = nowET();
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= 9 * 60 + 45;
}

/* ---------- SECOND ATTEMPT WINDOW HELPERS ---------- */
function inSecondForceWindow() {
  const d = nowET();
  return d.getHours() === 10 && (d.getMinutes() === 0 || d.getMinutes() === 1);
}
function inEndOfSecondForceFailsafe() {
  const d = nowET();
  return d.getHours() === 10 && d.getMinutes() === 1 && d.getSeconds() >= 30;
}
async function hasBuyAfter946TodayDB(): Promise<boolean> {
  const now = nowET();
  const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const start946 = new Date(etNow);
  start946.setHours(9, 46, 0, 0);
  const buy = await prisma.trade.findFirst({
    where: { side: "BUY", at: { gte: start946, lte: nowET() } },
    orderBy: { at: "desc" },
  });
  return !!buy;
}
async function hasAnyBuyTodayDB(): Promise<boolean> {
  const etNow = new Date(nowET().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dayStartET = new Date(etNow); dayStartET.setHours(0, 0, 0, 0);
  const buy = await prisma.trade.findFirst({
    where: { side: "BUY", at: { gte: dayStartET, lte: nowET() } },
    orderBy: { at: "desc" },
  });
  return !!buy;
}

/* -------------------------- FMP session candles (ABSOLUTE URL) -------------------------- */
function toET(dateIso: string) {
  return new Date(new Date(dateIso).toLocaleString("en-US", { timeZone: "America/New_York" }));
}
function isSameETDay(d: Date, ymd: string) {
  const mo = `${d.getMonth() + 1}`.padStart(2, "0");
  const da = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}` === ymd;
}
async function fetchCandles1m(symbol: string, limit: number, baseUrl: string): Promise<Candle[]> {
  const url = `${baseUrl}/api/fmp/candles?symbol=${encodeURIComponent(symbol)}&interval=1min&limit=${limit}`;
  const res = await fetch(url, { cache: "no-store" });
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

/* -------------------------- signals -------------------------- */
function computeOpeningRange(candles: Candle[], todayYMD: string) {
  const window = candles.filter((c) => {
    const d = toET(c.date);
    return isSameETDay(d, todayYMD) && d.getHours() === 9 && d.getMinutes() >= 30 && d.getMinutes() <= 33;
  });
  if (!window.length) return null;
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
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
  const prior = dayC.slice(-1 - lookback, -1);
  const avgPrior = prior.reduce((s, c) => s + c.volume, 0) / lookback;
  if (!avgPrior) return { mult: null as number | null, latestVol: latest.volume, avgPrior };
  return { mult: latest.volume / avgPrior, latestVol: latest.volume, avgPrior };
}

/* -------------------------- dip helpers -------------------------- */
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
function dipArmedNow(params: { candles: Candle[]; todayYMD: string; vwap: number | null }) {
  const { candles, todayYMD, vwap } = params;
  const day = candles.filter((c) => isSameETDay(toET(c.date), todayYMD));
  if (day.length < 2) return { armed: false, meta: { reason: "not_enough_bars" } };
  const last = day[day.length - 1]; const prev = day[day.length - 2];
  const open930 = sessionOpenAt930(candles, todayYMD);
  const minLow = dayMinLowSoFar(candles, todayYMD);
  if (open930 == null || minLow == null || open930 <= 0) return { armed: false, meta: { reason: "missing_open_or_min" } };
  const pullbackPct = (open930 - minLow) / open930;
  const withinDipBand = pullbackPct >= DIP_MIN_PCT && DIP_MAX_PCT >= pullbackPct;
  const brokePrevHigh = last.close > prev.high;
  const reclaimedVWAP = vwap != null ? last.close >= vwap : false;
  const confirmOK = DIP_CONFIRM_EITHER ? (brokePrevHigh || reclaimedVWAP) : (brokePrevHigh && reclaimedVWAP);
  const lastGreen = last.close >= last.open;
  const armed = !!(withinDipBand && confirmOK && lastGreen);
  return { armed, meta: { open930, minLow, pullbackPct, withinDipBand, brokePrevHigh, reclaimedVWAP, lastGreen } };
}

/* -------------------------- higher-low detection (9:30–9:44) -------------------------- */
function inWindow9344ET(dateIso: string): boolean {
  const d = toET(dateIso);
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= 9 * 60 + 44;
}

/** Find a higher-low after the first dip from the 9:30 open. */
function computeHigherLowAfterOpen(candles: Candle[], todayYMD: string) {
  const day = candles.filter((c) => isSameETDay(toET(c.date), todayYMD));
  if (day.length < 5) return { ok: false };

  const open930 = sessionOpenAt930(candles, todayYMD);
  if (open930 == null) return { ok: false };

  const win = day.filter((c) => inWindow9344ET(c.date));
  if (win.length < 3) return { ok: false };

  // Step 1: first local low after 9:30 (initial dip)
  let firstLowIdx = 0;
  let firstLow = Infinity;
  for (let i = 0; i < Math.min(win.length, 8); i++) {
    if (win[i].low < firstLow) {
      firstLow = win[i].low;
      firstLowIdx = i;
    }
  }
  if (!Number.isFinite(firstLow)) return { ok: false };

  // Step 2: find higher-low after that dip
  let higherLow = Infinity;
  let higherLowIdx = -1;
  for (let i = firstLowIdx + 1; i < win.length; i++) {
    const bar = win[i];
    if (bar.low < higherLow && bar.low > firstLow) {
      higherLow = bar.low;
      higherLowIdx = i;
    }
  }
  if (!Number.isFinite(higherLow) || higherLowIdx < 0) return { ok: false };

  // Step 3: confirmation — close above prior bar high
  let confirmClose: number | null = null;
  for (let i = higherLowIdx + 1; i < win.length; i++) {
    const bar = win[i];
    const prev = win[i - 1];
    if (bar.close > prev.high) {
      confirmClose = bar.close;
      break;
    }
  }
  if (confirmClose == null) return { ok: false };

  return { ok: true, firstLow, higherLow, confirmBarClose: confirmClose };
}

/* -------------------------- balanced decay & spread -------------------------- */
function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function minutesSince930ET() {
  const d = nowET();
  const mins = d.getHours() * 60 + d.getMinutes();
  const t = mins - (9 * 60 + 30);
  return Math.max(0, Math.min(DECAY_END_MIN, t));
}

/* ---------- float + liquidity (ABSOLUTE URL) ---------- */
async function fetchFloatShares(
  symbol: string,
  lastPrice: number | null,
  snapshot: { stocks: SnapStock[] } | null,
  baseUrl: string
): Promise<number | null> {
  const snap = snapshot?.stocks?.find(s => s.ticker === symbol);
  if (snap && Number.isFinite(Number(snap.float))) return Number(snap.float);

  try {
    const r = await fetch(`${baseUrl}/api/fmp/float?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const f = Number(j?.float ?? j?.floatShares ?? j?.freeFloat);
      if (Number.isFinite(f) && f > 0) return f;
    }
  } catch {}

  try {
    const r2 = await fetch(`${baseUrl}/api/fmp/profile?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
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
    if (Number.isFinite(so) && so > 0) return Math.floor(so * 0.8);
  }
  return null;
}

/* ====================== RELAXED LIQUIDITY CHECK (new helpers) ====================== */
function lastNBarsOfDay(candles: Candle[], todayYMD: string, n: number): Candle[] {
  const day = candles.filter((c) => isSameETDay(toET(c.date), todayYMD));
  if (!day.length) return [];
  return day.slice(-n);
}
function sumVolAndDollars(bars: Candle[], priceHint?: number | null) {
  let vol = 0;
  let dollars = 0;
  for (const b of bars) {
    vol += Number(b.volume) || 0;
    const px = Number.isFinite(Number(b.close)) ? Number(b.close) : Number(priceHint ?? 0);
    if (px > 0) dollars += (Number(b.volume) || 0) * px;
  }
  return { vol, dollars };
}
function passesRelaxedLiquidity(
  todayYMD: string,
  candles: Candle[],
  lastClose: number,
  floatShares: number | null,
  volPulseMult: number | null,
  volPulseMin: number
) {
  let minSharesReq = MIN_SHARES_ABS;
  if (Number.isFinite(Number(floatShares)) && floatShares! > 0) {
    const byFloat = Math.floor(floatShares! * FLOAT_MIN_PCT_PER_MIN);
    minSharesReq = Math.max(MIN_SHARES_ABS, byFloat);
  } else {
    minSharesReq = Math.max(3_000, MIN_SHARES_ABS);
  }

  const last1 = lastNBarsOfDay(candles, todayYMD, 1);
  const last3 = lastNBarsOfDay(candles, todayYMD, 3);

  const one = sumVolAndDollars(last1, lastClose);
  const three = sumVolAndDollars(last3, lastClose);

  const gateA = (one.vol >= minSharesReq) && (one.dollars >= MIN_DOLLAR_VOL);
  const gateB = (three.vol >= (2 * minSharesReq)) && (three.dollars >= (2 * MIN_DOLLAR_VOL));
  const gateC = (volPulseMult ?? 0) >= volPulseMin;

  const trueCount = [gateA, gateB, gateC].filter(Boolean).length;
  return {
    ok: trueCount >= 2,
    details: {
      minSharesReq,
      last1: { shares: one.vol, dollars: Math.round(one.dollars) },
      last3: { shares: three.vol, dollars: Math.round(three.dollars) },
      gates: { gateA, gateB, gateC, trueCount },
    }
  };
}
/* =================================================================================== */

/* >>>>>>>>>>>>>>> dynamic spread function <<<<<<<<<<<<<<< */
function dynamicSpreadLimitPct(now: Date, price?: number | null, phase: "scan" | "force" = "scan"): number {
  if (inWindow930to945ET()) {
    return 0.01; // 1%
  }
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

/* -------------------------- premarket memo -------------------------- */
type PreMemo = { pmHigh: number; pmLow: number; pmVol: number; fetchedAt: number };
const scanMemo: Record<string, PreMemo> = {};

/* -------------------------- evaluate entry (uses baseUrl) -------------------------- */
async function evaluateEntrySignals(
  ticker: string,
  snapshot: { stocks: SnapStock[] } | null,
  today: string,
  baseUrl: string
): Promise<{
  eligible: boolean;
  armed: boolean;
  armedMomentum: boolean;
  armedDip: boolean;
  armedHigherLow: boolean;
  refPrice: number | null;
  meta: any;
  debug: any;
}> {
  const dbg: any = {};
  const candles = await fetchCandles1m(ticker, 240, baseUrl);
  const day = candles.filter((c) => isSameETDay(toET(c.date), today));
  if (!day.length) {
    return { eligible: false, armed: false, armedMomentum: false, armedDip: false, armedHigherLow: false, refPrice: null, meta: { reason: "no_day_candles" }, debug: dbg };
  }
  const last = day[day.length - 1];

  // price band
  if (last.close < PRICE_MIN || last.close > PRICE_MAX) {
    return { eligible: false, armed: false, armedMomentum: false, armedDip: false, armedHigherLow: false, refPrice: last.close, meta: { reason: "price_band" }, debug: dbg };
  }

  // spread guard (scan phase)
  const spreadLimit = dynamicSpreadLimitPct(nowET(), last?.close ?? null, "scan");
  const spreadOK = await memoSpreadGuardOK(ticker, spreadLimit);
  dbg.spread = { limitPct: spreadLimit, spreadOK };
  if (!spreadOK) {
    return { eligible: false, armed: false, armedMomentum: false, armedDip: false, armedHigherLow: false, refPrice: last.close, meta: { reason: "spread_guard" }, debug: dbg };
  }

  // float/liquidity
  const floatShares = await fetchFloatShares(
    ticker,
    Number.isFinite(Number(last.close)) ? Number(last.close) : null,
    snapshot,
    baseUrl
  );

  const m = minutesSince930ET();
  const t = clamp01((m - DECAY_START_MIN) / (DECAY_END_MIN - DECAY_START_MIN));
  const VOL_MULT_MIN = lerp(VOL_MULT_START, VOL_MULT_END, t);

  const vwap = computeSessionVWAP(candles, today);
  const volPulse = computeVolumePulse(candles, today, 5);

  const liq = passesRelaxedLiquidity(
    today,
    candles,
    last.close,
    floatShares,
    volPulse?.mult ?? null,
    VOL_MULT_MIN
  );
  dbg.liquidity = {
    relaxed: true,
    float: floatShares ?? null,
    lastClose: last.close,
    details: liq.details,
    ok: liq.ok
  };
  if (!liq.ok) {
    return { eligible: false, armed: false, armedMomentum: false, armedDip: false, armedHigherLow: false, refPrice: last.close, meta: { reason: "liquidity" }, debug: dbg };
  }

  const orRange = computeOpeningRange(candles, today);
  const open930 = sessionOpenAt930(candles, today);
  const aboveVWAP = vwap != null && last ? last.close >= vwap : false;

  // near-OR/H reclaim + VWAP band
  const NEAR_OR_PCT = lerp(NEAR_OR_START, NEAR_OR_END, t);
  const VWAP_RECLAIM_BAND = lerp(VWAP_BAND_START, VWAP_BAND_END, t);
  const breakORH = !!(orRange && last && last.close > orRange.high);
  const nearOR = !!(orRange && last && last.close >= orRange.high * (1 - NEAR_OR_PCT));
  const vwapRecl = !!(vwap != null && last && last.close >= vwap && last.low >= vwap * (1 - VWAP_RECLAIM_BAND));
  const volOK = (volPulse?.mult ?? 0) >= VOL_MULT_MIN;

  // NEW: Higher-low pattern (9:30–9:44 only)
  const hl = computeHigherLowAfterOpen(candles, today);
  const armedHigherLow = !!hl.ok;

  // NEW: Not overextended relative to 9:30 open (don’t chase +12%+ during scan)
  let notOverextended = true;
  if (open930 != null && Number.isFinite(open930) && open930 > 0) {
    const ext = (last.close - open930) / open930;
    notOverextended = ext <= 0.12; // 12% cap during scan window
    dbg.overextension = { fromOpenPct: Number((ext * 100).toFixed(2)), notOverextended };
  }

  // Combine into momentum/dip/higher-low “armed” flags
  const signals: Record<string, boolean> = { volPulseOK: volOK, breakORH, nearOR, vwapReclaim: vwapRecl, higherLow: armedHigherLow, aboveVWAP };
  const signalCount = Object.values(signals).filter(Boolean).length;
  const armedMomentum = !!(aboveVWAP && vwapRecl && volOK && notOverextended && (breakORH || nearOR));
  const dip = dipArmedNow({ candles, todayYMD: today, vwap: vwap ?? null });

  // ✅ expose fields used by scoreSetup()
  dbg.volPulse = volPulse?.mult ?? null;
  dbg.VOL_MULT_MIN = VOL_MULT_MIN;

  dbg.signals = { ...signals, VOL_MULT_MIN, NEAR_OR_PCT, VWAP_RECLAIM_BAND, signalCount, mSince930: m, armedMomentum, armedDip: dip.armed, armedHigherLow };
  dbg.dipMeta = dip.meta;

  const eligible = true;
  const armed = armedMomentum || dip.armed || armedHigherLow;

  return {
    eligible,
    armed,
    armedMomentum,
    armedDip: dip.armed,
    armedHigherLow,
    refPrice: last.close ?? null,
    meta: { dipMeta: dip.meta, vwap, orRange, higherLow: hl },
    debug: dbg
  };
}

/* -------------------------- setup scoring (no time-of-day bonus) -------------------------- */
type SetupScore = { score: number; reasons: string[] };

function scoreSetup(e: Awaited<ReturnType<typeof evaluateEntrySignals>>): SetupScore {
  const r: string[] = [];
  let score = 0;

  // 1) Volume against dynamic minimum
  const volMult = Number(e?.debug?.volPulse ?? 0);
  const volMin  = Number(e?.debug?.V0L_MULT_MIN ?? e?.debug?.VOL_MULT_MIN ?? 999); // tolerate typo just in case
  if (Number.isFinite(volMult) && Number.isFinite(volMin) && volMult >= volMin) {
    score++; r.push(`volOK(${volMult.toFixed(2)}≥${volMin.toFixed(2)})`);
  } else {
    r.push(`volWeak(${(volMult||0).toFixed(2)}<${(volMin||0).toFixed(2)})`);
  }

  // 2) VWAP reclaim
  if (e?.debug?.signals?.vwapReclaim) { score++; r.push("vwapReclaim"); } else r.push("noVwapReclaim");

  // 3) ORH or near ORH
  if (e?.debug?.signals?.breakORH || e?.debug?.signals?.nearOR) { score++; r.push("ORH/nearOR"); } else r.push("noORH");

  // 4) Above VWAP
  if (e?.debug?.aboveVWAP) { score++; r.push("aboveVWAP"); } else r.push("belowVWAP");

  return { score, reasons: r };
}

/* -------- Option A: map score -> size (Full by default unless clearly weak) -------- */
function sizeForScoreOptionA(score: number): { sizeMult: number; label: "full"|"half"|"micro" } {
  if (score >= 2) return { sizeMult: SIZE_FULL, label: "full" };
  if (score === 1) return { sizeMult: SIZE_HALF, label: "half" };
  return { sizeMult: SIZE_MICRO, label: "micro" }; // score = 0
}

/* -------------------------- entry quality scoring for scan (9:30–9:44) -------------------------- */
function entryQualityScore(e: Awaited<ReturnType<typeof evaluateEntrySignals>>) {
  let score = 0;
  if (e.armedHigherLow) score += 3;   // best “nice entry” pattern
  if (e.armedDip)        score += 2;   // strong pullback confirm
  if (e.armedMomentum)   score += 1;   // balanced momentum

  // Volume factor (0..2)
  const volMult = Number(e?.debug?.volPulse ?? 0);
  const volMin  = Number(e?.debug?.VOL_MULT_MIN ?? 1);
  const volBoost = Math.max(0, Math.min(2, volMult / (volMin || 1)));
  score += volBoost;

  // Overextension guard: reward being less extended from 9:30 open (0..4)
  const extPct = Number(e?.debug?.overextension?.fromOpenPct ?? 0) / 100;
  const notOverextended = e?.debug?.overextension?.notOverextended ?? true;
  const extBoost = notOverextended ? Math.max(0, Math.min(4, 4 * (0.12 - Math.max(0, extPct)))) : 0;
  score += (isNaN(extBoost) ? 2 : extBoost);

  return {
    score,
    features: {
      armedHigherLow: e.armedHigherLow,
      armedDip: e.armedDip,
      armedMomentum: e.armedMomentum,
      volMult,
      volMin,
      extPct: Number((extPct*100).toFixed(2)),
    }
  };
}

/* -------------------------- order helper (ACCEPTS sizeMult + tpPct) -------------------------- */
async function placeEntryNow(ticker: string, ref: number, state: any, sizeMult = 1.0, tpPct = TARGET_PCT) {
  const cashNum = Number(state!.cash);

  // base budget capped by INVEST_BUDGET, scaled by size tier
  const budget = Math.max(0, Math.min(cashNum, INVEST_BUDGET) * Math.max(0.1, Math.min(sizeMult, 1.0)));

  let shares = Math.floor(budget / ref);
  if (shares <= 0 && budget >= ref) shares = 1;
  if (shares <= 0) return { ok: false, reason: `insufficient_cash_for_one_share_ref_${ticker}_${ref.toFixed(2)}` };

  // 1) Place temporary bracket off the ref (instant protection)
  const tmpTp = ref * (1 + tpPct);
  const tmpSl = ref * (1 + STOP_PCT);

  let order;
  try {
    order = await submitBracketBuy({
      symbol: ticker,
      qty: shares,
      entryType: "market",
      tp: tmpTp,
      sl: tmpSl,
      tif: "day",
    });
  } catch (e: any) {
    const msg = e?.message || "unknown";
    const body = e?.body ? JSON.stringify(e.body).slice(0, 300) : "";
    return { ok: false, reason: `alpaca_submit_failed_${ticker}:${msg}${body ? " body="+body : ""}` };
  }

  // 2) Poll for REAL average fill price
  let entry = Number.NaN;
  for (let i = 0; i < 24; i++) { // ~6s
    try {
      const pos = await getPosition(ticker);
      const px = Number(pos?.avg_entry_price);
      if (Number.isFinite(px) && px > 0) { entry = px; break; }
    } catch { /* transient */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!Number.isFinite(entry)) entry = ref; // fallback

  // 3) Recenter TP/SL from REAL fill (force=true to allow TP to go down)
  const newTp = round2(entry * (1 + tpPct));
  const newSl = round2(entry * (1 + STOP_PCT));
  try {
    await (replaceTpSlIfBetter as any)({ symbol: ticker, newTp, newSl, force: true });
  } catch {}

  // Initialize ratchet state + SL memo at entry
  ratchetState[ticker] = { entry, high: entry, lastRung: 0, lastLiftAt: 0 };
  lastDynSLMemo[ticker] = { day: yyyyMmDdET(), sl: newSl };

  // 4) Persist entry
  await prisma.position.create({ data: { ticker, entryPrice: entry, shares, open: true, brokerOrderId: order.id } });
  await prisma.trade.create({ data: { side: "BUY", ticker, price: entry, shares, brokerOrderId: order.id } });
  await prisma.botState.update({
    where: { id: 1 },
    data: { cash: cashNum - shares * entry, equity: cashNum - shares * entry + shares * entry },
  });

  return { ok: true, shares };
}

/* -------------------------- memos (ratchet + SL tracking) -------------------------- */
const partialTPMemo: Record<string, { day: string; taken: boolean }> = {};
const lastDynSLMemo: Record<string, { day: string; sl: number }> = {};
type TrailState = { day: string; active: boolean; anchor: number };
const trailHalfMemo: Record<string, TrailState> = {};

// New: per-symbol ratchet state (entry, high-water, last rung hit, last lift time)
type RatchetState = { entry: number; high: number; lastRung: number; lastLiftAt: number };
const ratchetState: Record<string, RatchetState> = {};

/* -------------------------- handlers -------------------------- */
export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }

async function handle(req: Request) {
  try {
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
      const base = getBaseUrl(req);

      // Ensure state exists
      let state = await prisma.botState.findUnique({ where: { id: 1 } });
      if (!state) {
        state = await prisma.botState.create({ data: { id: 1, cash: START_CASH, pnl: 0, equity: START_CASH } });
      }

      let openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
      let lastRec = await prisma.recommendation.findFirst({ orderBy: { id: "desc" } });
      let livePrice: number | null = null;

      // Real Alpaca balances (optional) — memoized (3s)
      let alpacaAccount: any = null;
      try { alpacaAccount = await memoGetAccount(); } catch {}

      const today = yyyyMmDdET();

      // Mandatory exit after 15:50 ET
      if (openPos && isMandatoryExitET()) {
        const exitTicker = openPos.ticker;
        try {
          await closePositionMarket(exitTicker);
          const q = await fmpQuoteCached(exitTicker);
          const parsed = priceFromFmp(q);
          const p = parsed != null ? parsed : Number(openPos.entryPrice);
          const shares = Number(openPos.shares);
          const entry = Number(openPos.entryPrice);
          const exitVal = shares * p;
          const realized = exitVal - shares * entry;

          await prisma.trade.create({ data: { side: "SELL", ticker: exitTicker, price: p, shares } });
          await prisma.position.update({ where: { id: openPos.id }, data: { open: false, exitPrice: p, exitAt: nowET() } });
          state = await prisma.botState.update({ where: { id: 1 }, data: { cash: Number(state!.cash) + exitVal, pnl: Number(state!.pnl) + realized, equity: Number(state!.cash) + exitVal } });

          openPos = null;
          debug.lastMessage = `Mandatory 15:50+ exit ${exitTicker}`;
        } catch { debug.reasons.push("mandatory_exit_exception"); }
      }

      // Weekday/market
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
            liquidity: { minSharesAbs: MIN_SHARES_ABS, floatPctPerMin: FLOAT_MIN_PCT_PER_MIN, minDollarVol: MIN_DOLLAR_VOL },
          },
          debug,
        };
      }
      const marketOpen = isMarketHoursET();

      // Pre-scan 09:14–09:29
      if (!openPos && inPreScanWindow()) {
        const snapshot = await getSnapshot(base);
        const top = (snapshot?.stocks || []).slice(0, TOP_CANDIDATES);
        const affordableTop = top.filter(s => Number.isFinite(Number(s.price)) && Number(s.price) <= INVEST_BUDGET);
        const candidates = affordableTop.length ? affordableTop : top;
        debug.presc_top = candidates.map((s) => s.ticker);

        try {
          const { primary, secondary, lastRecRow } = await ensureRollingRecommendationTwo(req, candidates);
          if (lastRecRow?.ticker) lastRec = lastRecRow;

          const picks = [primary, secondary].filter(Boolean) as string[];
          if (picks.length) {
            const { startISO, endISO } = premarketRangeISO(nowET());
            for (const sym of picks) {
              try {
                const bars = await getBars1m(sym, startISO, endISO);
                const pm = computePremarketLevelsFromBars(bars);
                if (pm) scanMemo[sym] = { pmHigh: pm.pmHigh, pmLow: pm.pmLow, pmVol: pm.pmVol, fetchedAt: Date.now() };
              } catch (e: any) { debug.reasons.push(`presc_pm_err_${sym}:${e?.message || "unknown"}`); }
            }
            debug.presc_pm_for = picks;
          } else {
            debug.reasons.push("presc_no_ai_picks_yet");
          }
        } catch (e: any) { debug.reasons.push(`presc_exception:${e?.message || "unknown"}`); }
      }

      // Scan 09:30–09:44 — head-to-head best entry between primary & secondary (+ fallback)
      if (!openPos && marketOpen && inScanWindow() && state!.lastRunDay !== today) {
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

        const { primary, secondary, lastRecRow } = await ensureRollingRecommendationTwo(req, candidates);

        let picks: string[] = [];
        let aiMissing = !primary;
        if (!primary && REQUIRE_AI_PICK && AI_FALLBACK_ENABLED && allowAIFallbackNow()) {
          const fb = await pickFallbackPrimary(snapshot, candidates, today, base);
          if (fb.sym) {
            picks = [fb.sym]; // single fallback primary
            debug.scan_fallback = { picked: fb.sym, reason: fb.reason };
            aiMissing = false; // we have a fallback "primary"
          }
        }

        if (aiMissing && REQUIRE_AI_PICK) {
          debug.reasons.push("scan_no_ai_pick_and_no_fallback");
        } else {
          if (lastRecRow?.ticker) lastRec = lastRecRow;
          if (!picks.length) picks = [primary, secondary].filter(Boolean) as string[];
          debug.scan_considered_order = picks;

          const evals: Record<string, Awaited<ReturnType<typeof evaluateEntrySignals>>> = {};
          for (const sym of picks) evals[sym!] = await evaluateEntrySignals(sym!, snapshot, today, base);
          debug.scan_evals = evals;

          let chosen: string | null = null;

          // Consider BOTH primary & secondary; pick best entry by quality score
          const eligiblePicks = picks.filter(s => {
            const ev = evals[s];
            return ev?.eligible && (ev.armedHigherLow || ev.armedDip || ev.armedMomentum);
          });

          if (eligiblePicks.length) {
            const ranked = eligiblePicks
              .map(sym => {
                const eq = entryQualityScore(evals[sym]!);
                return { sym, eq, vol: Number(evals[sym]?.debug?.volPulse ?? 0) };
              })
              .sort((a, b) => {
                if (b.eq.score !== a.eq.score) return b.eq.score - a.eq.score; // higher total wins
                return (b.vol || 0) - (a.vol || 0);                            // tie-break: more volume
              });

            chosen = ranked[0].sym;
            debug.scan_choice_reason = `best_entry_quality (${chosen})`;
            debug.scan_quality_rank = ranked.map(r => ({ ticker: r.sym, score: Number(r.eq.score.toFixed(2)), feats: r.eq.features }));
          } else {
            debug.reasons.push("scan_no_armed_signal_after_eval");
          }

          if (chosen) {
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
                  const chosenEval = evals[chosen]!;
                  const { score, reasons } = scoreSetup(chosenEval);
                  const { sizeMult, label } = sizeForScoreOptionA(score);
                  const tpPct = score >= 2 ? 0.10 : 0.05; // strong=10%, weak=5%
                  debug.scan_choice_scoring = { chosen, score, sizeLabel: label, tpPct, reasons, ref };

                  const placed = await placeEntryNow(chosen, Number(ref), state, sizeMult, tpPct);
                  if (placed.ok) {
                    debug.lastMessage = `BUY (${chosenEval.armedHigherLow ? "Higher-Low" : (chosenEval.armedDip ? "Buy-the-Dip" : "Balanced")}) ${chosen} @ ~${Number(ref).toFixed(2)} (shares=${placed.shares}, size=${label}, score=${score}, tp=${(tpPct*100).toFixed(0)}%)`;
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
          }
        }
      }

      // Force window 09:45–09:46 — PRIMARY-ONLY (+ fallback) + Option A sizing + TP override
      if (!openPos && marketOpen && inForceWindow() && state!.lastRunDay !== today) {
        if (await hasAnyBuyTodayDB()) {
          debug.reasons.push("force_skipped_buy_exists_today");
        } else {
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
            const { primary, secondary, lastRecRow } = await ensureRollingRecommendationTwo(req, candidates, 10_000);
            if (lastRecRow?.ticker) lastRec = lastRecRow;

            // ⬇️ PRIMARY ONLY during FORCE; fallback if missing
            let picks = primary ? [primary] : [];
            if (!picks.length && AI_FALLBACK_ENABLED) {
              const fb = await pickFallbackPrimary(snapshot, candidates, yyyyMmDdET(), base);
              if (fb.sym) {
                picks = [fb.sym];
                debug[`force_iter_${i}_fallback`] = { picked: fb.sym, reason: fb.reason };
              }
            }
            if (!picks.length) {
              debug.reasons.push(`force_no_primary_and_no_fallback_iter_${i}`);
              await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
              continue;
            }

            debug[`force_iter_${i}_primary`] = picks[0];

            let entered = false;
            for (const sym of picks) {
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
              const spreadOK = await memoSpreadGuardOK(sym!, spreadLimit);
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

              // quick score for size + tp
              try {
                const evalRes = await evaluateEntrySignals(sym!, snapshot, yyyyMmDdET(), base);
                const { score, reasons } = scoreSetup(evalRes);
                const { sizeMult, label } = sizeForScoreOptionA(score);
                const tpPct = score >= 2 ? 0.10 : 0.05;
                debug[`force_score_${sym}`] = { score, sizeLabel: label, reasons, ref, tpPct };

                const placed = await placeEntryNow(sym!, Number(ref), state!, sizeMult, tpPct);
                if (placed.ok) {
                  debug.lastMessage = `09:45 FORCE BUY (PRIMARY) ${sym} @ ~${Number(ref).toFixed(2)} (shares=${placed.shares}, size=${label}, score=${score}, tp=${(tpPct*100).toFixed(0)}%)`;
                  openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
                  entered = true;
                  break;
                } else {
                  debug.reasons.push(`force_place_entry_failed_${sym}:${placed.reason}`);
                  await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
                }
              } catch (e:any) {
                debug.reasons.push(`force_eval_exception_${sym}:${e?.message||"unknown"}`);
                await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
              }
            }
            if (entered) break;
            await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          }
        }
      }

      // End-of-force failsafe
      if (!openPos && inEndOfForceFailsafe()) {
        const anyBuyToday = await hasAnyBuyTodayDB();
        if (!anyBuyToday && state!.lastRunDay === yyyyMmDdET()) {
          await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
          debug.reasons.push("force_failsafe_cleared_day_lock");
        } else {
          debug.reasons.push("force_failsafe_kept_day_lock_due_to_buy_today");
        }
      }

      /* --------------------- SECOND ATTEMPT 10:00–10:01 (PRIMARY-ONLY + fallback) --------------------- */
      if (!openPos && marketOpen && inSecondForceWindow() && state!.lastRunDay !== today) {
        if (await hasAnyBuyTodayDB()) {
          debug.reasons.push("second_force_skipped_buy_exists_today");
        } else {
          let snapshot = await getSnapshot(base);
          let top = (snapshot?.stocks || []).slice(0, TOP_CANDIDATES);
          if (!top.length && lastGoodSnapshot && lastGoodSnapshotDay === today) {
            top = lastGoodSnapshot.stocks.slice(0, TOP_CANDIDATES);
            debug.used_last_good_snapshot_second_force = true;
          }
          const affordableTop = top.filter(s => Number.isFinite(Number(s.price)) && Number(s.price) <= INVEST_BUDGET);
          const candidates = affordableTop.length ? affordableTop : top;

          debug.second_force_top = candidates.map((s) => s.ticker);
          debug.second_force_affordable_count = affordableTop.length;

          const BURST_TRIES = 10;
          const BURST_DELAY_MS = 300;

          for (let i = 0; i < BURST_TRIES && !openPos; i++) {
            const { primary, secondary, lastRecRow } = await ensureRollingRecommendationTwo(req, candidates, 10_000);
            if (lastRecRow?.ticker) lastRec = lastRecRow;

            // ⬇️ PRIMARY ONLY during SECOND FORCE; fallback if missing
            let picks = primary ? [primary] : [];
            if (!picks.length && AI_FALLBACK_ENABLED) {
              const fb = await pickFallbackPrimary(snapshot, candidates, yyyyMmDdET(), base);
              if (fb.sym) {
                picks = [fb.sym];
                debug[`second_force_iter_${i}_fallback`] = { picked: fb.sym, reason: fb.reason };
              }
            }
            if (!picks.length) {
              debug.reasons.push(`second_force_no_primary_and_no_fallback_iter_${i}`);
              await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
              continue;
            }

            debug[`second_force_iter_${i}_primary`] = picks[0];

            let entered = false;
            for (const sym of picks) {
              let ref: number | null = Number(snapshot?.stocks?.find((s) => s.ticker === sym)?.price ?? NaN);
              if (!Number.isFinite(Number(ref))) {
                const q = await fmpQuoteCached(sym!);
                const p = priceFromFmp(q);
                if (p != null) ref = p;
              }
              if (ref == null || !Number.isFinite(Number(ref))) {
                debug.reasons.push(`second_force_no_price_for_entry_${sym}`);
                continue;
              }
              if (ref < PRICE_MIN || ref > PRICE_MAX) {
                debug.reasons.push(`second_force_price_band_fail_${sym}_${Number(ref).toFixed(2)}`);
                continue;
              }
              const spreadLimit = dynamicSpreadLimitPct(nowET(), ref ?? null, "force");
              const spreadOK = await memoSpreadGuardOK(sym!, spreadLimit);
              if (!spreadOK) {
                debug.reasons.push(`second_force_spread_guard_fail_${sym}_limit=${(spreadLimit * 100).toFixed(2)}%`);
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

              try {
                const evalRes = await evaluateEntrySignals(sym!, snapshot, yyyyMmDdET(), base);
                const { score, reasons } = scoreSetup(evalRes);
                const { sizeMult, label } = sizeForScoreOptionA(score);
                const tpPct = score >= 2 ? 0.10 : 0.05;
                debug[`second_force_score_${sym}`] = { score, sizeLabel: label, reasons, ref, tpPct };

                const placed = await placeEntryNow(sym!, Number(ref), state!, sizeMult, tpPct);
                if (placed.ok) {
                  debug.lastMessage = `10:00 SECOND FORCE BUY (PRIMARY) ${sym} @ ~${Number(ref).toFixed(2)} (shares=${placed.shares}, size=${label}, score=${score}, tp=${(tpPct*100).toFixed(0)}%)`;
                  openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
                  entered = true;
                  break;
                } else {
                  debug.reasons.push(`second_force_place_entry_failed_${sym}:${placed.reason}`);
                  await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
                }
              } catch (e:any) {
                debug.reasons.push(`second_force_eval_exception_${sym}:${e?.message||"unknown"}`);
                await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
              }
            }

            if (entered) break;
            await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          }
        }
      }

      // End-of-second-force failsafe
      if (!openPos && inEndOfSecondForceFailsafe()) {
        const anyBuyToday = await hasAnyBuyTodayDB();
        if (!anyBuyToday && state!.lastRunDay === yyyyMmDdET()) {
          await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
          debug.reasons.push("second_force_failsafe_cleared_day_lock");
        } else {
          debug.reasons.push("second_force_failsafe_kept_day_lock_due_to_buy_today");
        }
      }

      // Holding loop — exits handled by broker bracket (PLUS: 5% staircase ratchet that only lifts SL)
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

          // -------- 5% STAIRCASE RATCHET (only-up stop) --------
          if (RATCHET_ENABLED && RATCHET_LIFT_BROKER_CHILDREN) {
            const sym = openPos.ticker;
            const entry = Number(openPos.entryPrice);
            if (!ratchetState[sym]) {
              ratchetState[sym] = { entry, high: Math.max(entry, p), lastRung: 0, lastLiftAt: 0 };
            }
            const rs = ratchetState[sym];
            rs.high = Math.max(rs.high, p); // update high-water

            const gainPct = (rs.high - rs.entry) / rs.entry;
            const rungIndex = Math.floor(gainPct / RATCHET_STEP_PCT); // 0,1,2,...

            // Determine staircase stop relative to entry:
            // rung 0 => initial stop (-5%), rung 1 => 0% (BE), rung 2 => +5%, rung 3 => +10%, ...
            const candidatePctFromEntry = Math.max(0, (rungIndex - 1) * RATCHET_STEP_PCT);
            const candidateSL = round2(rs.entry * (1 + candidatePctFromEntry));

            // Cap tightness: don't clamp tighter than 5% below high-water
            const maxTightStop = round2(rs.high * (1 - MAX_TIGHTNESS_BEHIND_HIGH));
            const targetSL = Math.min(candidateSL, maxTightStop);

            // Current SL memo (or initial -5% if unset)
            const curMemo = lastDynSLMemo[sym]?.sl ?? round2(rs.entry * (1 + STOP_PCT));

            // Only lift if improved, rung advanced, and cooldown OK
            const improvedBy = targetSL - curMemo;
            const nowMs = Date.now();
            const cooldownOK = nowMs - (rs.lastLiftAt || 0) >= LIFT_COOLDOWN_MS;

            if (rungIndex > rs.lastRung && improvedBy >= MIN_SL_IMPROVE_CENTS && cooldownOK) {
              try {
                await (replaceTpSlIfBetter as any)({
                  symbol: sym,
                  newSl: targetSL,
                  force: false, // NEVER lower stop
                });
                lastDynSLMemo[sym] = { day: yyyyMmDdET(), sl: targetSL };
                rs.lastRung = rungIndex;
                rs.lastLiftAt = nowMs;

                debug.ratchet = {
                  symbol: sym,
                  entry: rs.entry,
                  high: rs.high,
                  rungIndex,
                  candidatePctFromEntry: Number((candidatePctFromEntry * 100).toFixed(1)) + "%",
                  targetSL,
                  maxTightStop,
                  improvedBy: Number(improvedBy.toFixed(2)),
                  liftedAt: new Date(nowMs).toISOString(),
                };
              } catch (e: any) {
                debug.reasons.push(`ratchet_lift_failed_${sym}:${e?.message || "unknown"}`);
              }
            } else {
              debug.ratchet = {
                symbol: sym,
                entry: rs.entry,
                high: rs.high,
                rungIndex,
                curSL: curMemo,
                targetSL,
                cooldownOK,
                improvedBy: Number(improvedBy.toFixed(2)),
              };
            }
          }
          // -------- end staircase ratchet --------
        }
      } else if (lastRec?.ticker) {
        const q = await fmpQuoteCached(lastRec.ticker);
        const p = priceFromFmp(q);
        if (p != null) livePrice = p;
      }

      /* ---------------------- VIEW SYMBOL UNTIL 23:59 ET ---------------------- */
      const etNow = new Date(nowET().toLocaleString("en-US", { timeZone: "America/New_York" }));
      const dayStartET = new Date(etNow); dayStartET.setHours(0, 0, 0, 0);
      const endOfDayET = new Date(etNow); endOfDayET.setHours(23, 59, 0, 0);

      // Most recent BUY today (even if already sold)
      const lastBuyToday = await prisma.trade.findFirst({
        where: { side: "BUY", at: { gte: dayStartET } },
        orderBy: { at: "desc" },
      });

      const viewSymbol = openPos?.ticker ?? lastBuyToday?.ticker ?? null;

      return {
        state,
        lastRec,
        position: openPos,
        live: { ticker: openPos?.ticker ?? lastRec?.ticker ?? null, price: livePrice },
        view: {
          symbol: viewSymbol,
          untilET: endOfDayET.toISOString(),
        },
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
          liquidity: { minSharesAbs: MIN_SHARES_ABS, floatPctPerMin: FLOAT_MIN_PCT_PER_MIN, minDollarVol: MIN_DOLLAR_VOL },
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
  } catch (e: any) {
    const msg = e?.message || "unknown";
    const stack = typeof e?.stack === "string" ? e.stack.split("\n").slice(0, 6).join("\n") : undefined;
    return new NextResponse(
      JSON.stringify({ error: true, message: msg, stack }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}

/* -------------------------- snapshot cache -------------------------- */
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

/* -------------------------- AI pick parsing & rolling recs -------------------------- */
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
  const fields = [rJson?.ticker, rJson?.symbol, rJson?.pick, rJson?.Pick, rJson?.data?.ticker, rJson?.data?.symbol];
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

/* -------------------------- Fallback picker (NEW) -------------------------- */
async function pickFallbackPrimary(
  snapshot: { stocks: SnapStock[] } | null,
  candidates: SnapStock[],
  today: string,
  base: string
): Promise<{ sym: string | null; reason: string; eval?: Awaited<ReturnType<typeof evaluateEntrySignals>> }> {
  const evals: Array<{sym:string; ev: Awaited<ReturnType<typeof evaluateEntrySignals>>; eq:number}> = [];
  for (const s of candidates.slice(0, TOP_CANDIDATES)) {
    const ev = await evaluateEntrySignals(s.ticker, snapshot, today, base);
    if (ev?.eligible && (ev.armedHigherLow || ev.armedDip || ev.armedMomentum)) {
      const eq = entryQualityScore(ev).score;
      evals.push({ sym: s.ticker, ev, eq });
    }
  }
  if (!evals.length) return { sym: null, reason: "fallback_no_armed_candidates" };
  evals.sort((a,b)=> b.eq - a.eq);
  return { sym: evals[0].sym, reason: "fallback_best_entry_quality", eval: evals[0].ev };
}
