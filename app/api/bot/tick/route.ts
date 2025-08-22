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

/** Robust AI recommendation parser */
function parseAIPick(rJson: any): string | null {
  const fields = [
    rJson?.ticker,
    rJson?.symbol,
    rJson?.pick,
    rJson?.Pick,
    rJson?.data?.ticker,
    rJson?.data?.symbol,
  ];
  for (const f of fields) {
    if (typeof f === "string" && /^[A-Za-z][A-Za-z0-9.\-]*$/.test(f)) {
      return f.toUpperCase();
    }
  }
  const ctxTicker = rJson?.context?.tickers?.[0]?.ticker;
  if (typeof ctxTicker === "string" && /^[A-Za-z][A-Za-z0-9.\-]*$/.test(ctxTicker)) {
    return ctxTicker.toUpperCase();
  }
  let txt = String(rJson?.recommendation ?? rJson?.text ?? rJson?.message ?? "");
  txt = txt.replace(/[*_`~]/g, "").replace(/^-+\s*/gm, "");
  const m1 = /Pick\s*:?\s*([A-Z][A-Z0-9.\-]*)/i.exec(txt);
  const m2 = /Pick\s*[-–—]\s*([A-Z][A-Z0-9.\-]*)/i.exec(txt);
  const sym = (m1?.[1] || m2?.[1])?.toUpperCase();
  return sym || null;
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

/** Keep AI pick rolling */
async function ensureRollingRecommendationFromSnapshot(
  req: Request,
  topStocks: SnapStock[],
  freshnessMs = FRESHNESS_MS
) {
  const now = nowET();
  const today = yyyyMmDd(now);
  let lastRec = await prisma.recommendation.findFirst({ orderBy: { id: "desc" } });

  const lastAt = lastRec?.at instanceof Date ? lastRec.at.getTime() : 0;
  const tooOld = !lastAt || (now.getTime() - lastAt > freshnessMs);
  const notToday = lastRec ? yyyyMmDd(lastRec.at as Date) !== today : true;
  const notInTop = lastRec?.ticker ? !topStocks.some(s => s.ticker === lastRec!.ticker) : true;

  if (tooOld || notToday || notInTop) {
    try {
      const base = getBaseUrl(req);
      const rRes = await fetch(`${base}/api/recommendation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stocks: topStocks, forcePick: true, requirePick: true }),
        cache: "no-store",
      });

      if (rRes.ok) {
        const rJson = await rRes.json();
        const ticker = parseAIPick(rJson);
        if (ticker) {
          const snapPrice = topStocks.find((s) => s.ticker === ticker)?.price;
          const priceCandidate = snapPrice ?? (await getQuote(ticker));
          if (priceCandidate != null && Number.isFinite(Number(priceCandidate))) {
            lastRec = await prisma.recommendation.create({
              data: { ticker, price: Number(priceCandidate) },
            });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return lastRec || null;
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

/** minutes since 9:30 (0..>=44) within scan window */
function minutesSince930ET() {
  const d = nowET();
  const mins = d.getHours() * 60 + d.getMinutes();
  const t = mins - (9 * 60 + 30);
  return Math.max(0, Math.min(44, t)); // cap at 44 (10:14)
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
            cash:   Number(state.cash) + exitVal,
            pnl:    Number(state.pnl) + realized,
            equity: Number(state.cash) + exitVal,
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
        const rec = await ensureRollingRecommendationFromSnapshot(req, candidates);
        if (rec?.ticker) {
          lastRec = rec;
          const { startISO, endISO } = premarketRangeISO(nowET());
          try {
            const bars = await getBars1m(rec.ticker, startISO, endISO);
            const pm = computePremarketLevelsFromBars(bars);
            if (pm) {
              scanMemo[rec.ticker] = { pmHigh: pm.pmHigh, pmLow: pm.pmLow, pmVol: pm.pmVol, fetchedAt: Date.now() };
              debug.presc_pm = { ticker: rec.ticker, ...pm };
            } else {
              debug.reasons.push("presc_no_pm_bars");
            }
          } catch (e: any) {
            debug.reasons.push(`presc_alpaca_data_error:${e?.message || "unknown"}`);
          }
        } else {
          debug.reasons.push("presc_no_ai_pick_yet");
        }
      } catch (e: any) {
        debug.reasons.push(`presc_exception:${e?.message || "unknown"}`);
      }
    }

    /** ───────────────── 09:30–10:14 Scan Window (Balanced profile) ───────────────── */
    if (!openPos && marketOpen && inScanWindow() && state.lastRunDay !== today) {
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

      const rec = await ensureRollingRecommendationFromSnapshot(req, candidates);
      if (!rec?.ticker) {
        debug.reasons.push("scan_no_ai_pick_yet");
      } else {
        lastRec = rec;
        try {
          const candles = await fetchCandles1m(rec!.ticker, 240);
          const day = candles.filter((c) => isSameETDay(toET(c.date), today));
          if (!day.length) {
            debug.reasons.push("scan_no_day_candles");
          } else {
            const last = day[day.length - 1];

            // Execution guards (fixed)
            if (last.close < PRICE_MIN || last.close > PRICE_MAX) {
              debug.reasons.push(`scan_price_band_fail_${last.close.toFixed(2)}`);
              throw new Error("price_band_fail");
            }
            if ((last.volume ?? 0) < MIN_1M_VOL) {
              debug.reasons.push(`scan_min_1m_vol_fail_${last.volume ?? 0}`);
              throw new Error("min_vol_fail");
            }

            // Spread guard (FREE Alpaca IEX quote)
            const spreadOK = await spreadGuardOK(rec.ticker, SPREAD_MAX_PCT);
            debug.scan_spread_ok = spreadOK;
            if (!spreadOK) {
              debug.reasons.push("scan_spread_guard_fail");
              throw new Error("spread_guard_fail");
            }

            // Time-decayed thresholds
            const m = minutesSince930ET(); // 0..44
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

            // Any-2-of-4 rule (plus aboveVWAP hard requirement)
            const signals: Record<string, boolean> = {
              volPulseOK: volOK,
              breakORH: breakORH,
              nearOR: nearOR,
              vwapReclaim: vwapRecl,
            };
            const signalCount = Object.values(signals).filter(Boolean).length;
            const armed = !!(aboveVWAP && signalCount >= 2);

            // Optional extra info for UI
            const memo = scanMemo[rec.ticker];
            if (memo) {
              debug.scan_pm_ctx = { pmHigh: memo.pmHigh, pmLow: memo.pmLow, pmVol: memo.pmVol };
            }
            debug.scan_signals = {
              aboveVWAP,
              volPulse: vol?.mult ?? null,
              VOL_MULT_MIN,
              breakORH,
              nearOR,
              NEAR_OR_PCT,
              vwapRecl,
              VWAP_RECLAIM_BAND,
              signalCount,
              mSince930: m
            };

            if (armed) {
              // Claim day lock right before placing the order
              const claim = await prisma.botState.updateMany({
                where: { id: 1, OR: [{ lastRunDay: null }, { lastRunDay: { not: today } }] },
                data: { lastRunDay: today },
              });
              const claimed = claim.count === 1;
              if (!claimed) {
                debug.reasons.push("scan_day_lock_already_claimed");
              } else {
                // Re-check no position
                openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
                if (openPos) {
                  debug.reasons.push("scan_pos_open_after_claim");
                } else {
                  // Reference price
                  let ref: number | null =
                    Number(snapshot?.stocks?.find((s) => s.ticker === rec!.ticker)?.price ?? NaN);
                  if (!Number.isFinite(Number(ref))) ref = Number(rec!.price);
                  if (!Number.isFinite(Number(ref))) {
                    const q = await getQuote(rec!.ticker);
                    if (q != null && Number.isFinite(Number(q))) ref = Number(q);
                  }

                  if (ref == null || !Number.isFinite(Number(ref))) {
                    debug.reasons.push("scan_no_price_for_entry");
                    await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
                  } else {
                    const cashNum = Number(state.cash);
                    const shares = Math.floor(Math.min(cashNum, INVEST_BUDGET) / ref);
                    if (shares <= 0) {
                      debug.reasons.push(`scan_insufficient_cash_for_one_share_ref_${ref.toFixed(2)}`);
                      await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
                    } else {
                      const tp = ref * (1 + TARGET_PCT);
                      const sl = ref * (1 + STOP_PCT);

                      try {
                        const order = await submitBracketBuy({
                          symbol: rec!.ticker,
                          qty: shares,
                          entryType: "market",
                          tp,
                          sl,
                          tif: "day",
                        });

                        const pos = await prisma.position.create({
                          data: { ticker: rec!.ticker, entryPrice: ref, shares, open: true, brokerOrderId: order.id },
                        });
                        openPos = pos;

                        await prisma.trade.create({
                          data: { side: "BUY", ticker: rec!.ticker, price: ref, shares, brokerOrderId: order.id },
                        });

                        await prisma.botState.update({
                          where: { id: 1 },
                          data: { cash: cashNum - shares * ref, equity: cashNum - shares * ref + shares * ref },
                        });

                        debug.lastMessage = `✅ BUY (Balanced setup) ${rec!.ticker} @ ~${ref.toFixed(2)} (shares=${shares})`;
                      } catch (e: any) {
                        const msg = e?.message || "unknown";
                        const body = e?.body ? JSON.stringify(e.body).slice(0, 300) : "";
                        debug.reasons.push(`scan_alpaca_submit_failed:${msg}${body ? " body="+body : ""}`);
                        await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
                      }
                    }
                  }
                }
              }
            } else {
              debug.reasons.push("scan_signals_not_armed");
            }
          }
        } catch (e: any) {
          if (!String(e?.message || "").includes("price_band_fail") &&
              !String(e?.message || "").includes("min_vol_fail") &&
              !String(e?.message || "").includes("spread_guard_fail")) {
            debug.reasons.push(`scan_signal_exception:${e?.message || "unknown"}`);
          }
        }
      }
    }

    /** ───────────────── 10:15–10:16 Force Window (signals ignored, guards enforced) ───────────────── */
    if (!openPos && marketOpen && inForceWindow() && state.lastRunDay !== today) {
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
        const rec = await ensureRollingRecommendationFromSnapshot(req, candidates, 10_000);
        if (!rec?.ticker) {
          debug.reasons.push(`force_no_ai_pick_iter_${i}`);
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }

        lastRec = rec;

        // Spread + price band guards even for force-buy
        const spreadOK = await spreadGuardOK(rec.ticker, SPREAD_MAX_PCT);
        debug[`force_iter_${i}_spread_ok`] = spreadOK;
        if (!spreadOK) {
          debug.reasons.push(`force_spread_guard_fail_iter_${i}`);
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }

        // Resolve a reference price for band check & sizing
        let ref: number | null =
          Number(snapshot?.stocks?.find((s) => s.ticker === rec!.ticker)?.price ?? NaN);
        if (!Number.isFinite(Number(ref))) ref = Number(rec!.price);
        if (!Number.isFinite(Number(ref))) {
          const q = await getQuote(rec!.ticker);
          if (q != null && Number.isFinite(Number(q))) ref = Number(q);
        }
        if (ref == null || !Number.isFinite(Number(ref))) {
          debug.reasons.push(`force_no_price_for_entry_iter_${i}`);
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }
        if (ref < PRICE_MIN || ref > PRICE_MAX) {
          debug.reasons.push(`force_price_band_fail_${ref.toFixed(2)}_iter_${i}`);
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }

        const claim = await prisma.botState.updateMany({
          where: { id: 1, OR: [{ lastRunDay: null }, { lastRunDay: { not: today } }] },
          data: { lastRunDay: today },
        });
        const claimed = claim.count === 1;
        debug[`force_iter_${i}_claimed`] = claimed;

        if (!claimed) {
          debug.reasons.push(`force_day_lock_already_claimed_iter_${i}`);
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }

        openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
        if (openPos) break;

        const cashNum = Number(state.cash);
        const shares = Math.floor(Math.min(cashNum, INVEST_BUDGET) / ref);
        if (shares <= 0) {
          debug.reasons.push(`force_insufficient_cash_for_one_share_ref_${ref.toFixed(2)}_iter_${i}`);
          await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }

        const tp = ref * (1 + TARGET_PCT);
        const sl = ref * (1 + STOP_PCT);

        try {
          const order = await submitBracketBuy({
            symbol: rec!.ticker,
            qty: shares,
            entryType: "market",
            tp,
            sl,
            tif: "day",
          });

          const pos = await prisma.position.create({
            data: { ticker: rec!.ticker, entryPrice: ref, shares, open: true, brokerOrderId: order.id },
          });
          openPos = pos;

          await prisma.trade.create({
            data: { side: "BUY", ticker: rec!.ticker, price: ref, shares, brokerOrderId: order.id },
          });

          await prisma.botState.update({
            where: { id: 1 },
            data: { cash: cashNum - shares * ref, equity: cashNum - shares * ref + shares * ref },
          });

          debug.lastMessage = `✅ 10:15 FORCE BUY (guards ok) ${rec!.ticker} @ ~${ref.toFixed(2)} (shares=${shares})`;
          break;
        } catch (e: any) {
          const msg = e?.message || "unknown";
          const body = e?.body ? JSON.stringify(e.body).slice(0, 300) : "";
          debug.reasons.push(`force_alpaca_submit_failed_iter_${i}:${msg}${body ? " body="+body : ""}`);
          await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }
      }
    }

    /** ── End-of-force failsafe: clear stuck lock ── */
    if (!openPos && inEndOfForceFailsafe()) {
      if (state.lastRunDay === yyyyMmDdET()) {
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

        const equityNow = Number(state.cash) + Number(openPos.shares) * p;
        if (Number(state.equity) !== equityNow) {
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

                    debug.ratchet_replace = {
                      step: rat.steps,
                      message: replaced.message,
                      triedTp: replaced.triedTp,
                      triedSl: replaced.triedSl,
                      prevTp: replaced.prevTp,
                      prevSl: replaced.prevSl,
                      cooldownMs: LIFT_COOLDOWN_MS,
                    };
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
                // Virtual TP
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
                        cash:   Number(state.cash) + exitVal,
                        pnl:    Number(state.pnl) + realized,
                        equity: Number(state.cash) + exitVal,
                      },
                    });

                    debug.lastMessage = `🏁 Ratchet TP hit ${exitTicker} @ ${p.toFixed(2)} (dynTP=${rat.dynTP.toFixed(2)})`;
                    openPos = null;
                  } catch (e: any) {
                    debug.reasons.push(`ratchet_tp_close_exception:${e?.message || "unknown"}`);
                  }
                }
                // Virtual SL
                else if (p <= rat.dynSL) {
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
                        cash:   Number(state.cash) + exitVal,
                        pnl:    Number(state.pnl) + realized,
                        equity: Number(state.cash) + exitVal,
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
