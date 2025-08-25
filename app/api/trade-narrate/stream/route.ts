// app/api/trade-narrate/stream/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest } from "next/server";
import { spreadGuardOK } from "@/lib/alpaca";

/** ─────────────────── Mirrors your bot’s settings ─────────────────── */
// Price/spread guards (scan + force)
const PRICE_MIN = 1;
const PRICE_MAX = 70;
const SPREAD_MAX_PCT = 0.005; // 0.50%

// Scan decay window 9:30–9:44
const DECAY_START_MIN = 0;
const DECAY_END_MIN = 14;

// Decaying thresholds (same as bot)
const VOL_MULT_START = 1.20;
const VOL_MULT_END   = 1.10;
const NEAR_OR_START  = 0.003;   // 0.30%
const NEAR_OR_END    = 0.0045;  // 0.45%
const VWAP_BAND_START = 0.002;  // 0.20%
const VWAP_BAND_END   = 0.003;  // 0.30%

// Balanced liquidity guard (SCAN ONLY — not used in force)
const MIN_SHARES_ABS = 8_000;
const FLOAT_MIN_PCT_PER_MIN = 0.0025; // 0.25%
const MIN_DOLLAR_VOL = 200_000;

// Risk plan (for narration)
const TARGET_PCT = 0.10;
const STOP_PCT   = -0.05;

/** ─────────────────── Time helpers (ET) ─────────────────── */
function nowET(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}
function hhmmssET(d = nowET()) {
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mm = `${d.getMinutes()}`.padStart(2, "0");
  const ss = `${d.getSeconds()}`.padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
function yyyyMmDdET() {
  const d = nowET();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}`;
}
function toET(dateIso: string) {
  return new Date(new Date(dateIso).toLocaleString("en-US", { timeZone: "America/New_York" }));
}
function isSameETDay(d: Date, ymd: string) {
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}` === ymd;
}
function minutesSince930ET() {
  const d = nowET();
  const mins = d.getHours() * 60 + d.getMinutes();
  const t = mins - (9 * 60 + 30);
  return Math.max(0, Math.min(DECAY_END_MIN, t));
}
function inScanWindowET() {
  const d = nowET();
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= 9 * 60 + 30 && m <= 9 * 60 + 44;
}
function inForceWindowET() {
  const d = nowET();
  return d.getHours() === 9 && (d.getMinutes() === 45 || d.getMinutes() === 46);
}

/** ─────────────────── Math helpers ─────────────────── */
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const td = new TextEncoder();

/** ─────────────────── Market data helpers ─────────────────── */
type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };

async function fetchCandles1m(symbol: string, limit = 240): Promise<Candle[]> {
  const res = await fetch(`/api/fmp/candles?symbol=${encodeURIComponent(symbol)}&interval=1min&limit=${limit}`, { cache: "no-store" });
  if (!res.ok) return [];
  const j = await res.json();
  const arr = Array.isArray(j?.candles) ? j.candles : [];
  return arr.map((c: any) => ({
    date: c.date, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume),
  }));
}
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

/** Float lookups (same fallbacks as bot) */
async function fetchFloatShares(symbol: string, lastPrice: number | null): Promise<number | null> {
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

  try {
    const r3 = await fetch(`/api/fmp/quote?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    if (r3.ok) {
      const j3 = await r3.json();
      const row = (Array.isArray(j3) ? j3[0] : j3) || {};
      const mcap = Number(row.marketCap);
      const p = Number(lastPrice ?? row.price);
      if (Number.isFinite(mcap) && Number.isFinite(p) && p > 0) {
        const so = mcap / p;
        if (Number.isFinite(so) && so > 0) return Math.floor(so * 0.8);
      }
    }
  } catch {}

  return null;
}

/** Balanced liquidity (SCAN ONLY) */
function passesBalancedLiquidityGuard(lastClose: number, lastVolume: number, floatShares: number | null) {
  const dollarVol = lastClose * lastVolume;
  let minSharesReq = MIN_SHARES_ABS;
  if (Number.isFinite(Number(floatShares)) && floatShares! > 0) {
    const byFloat = Math.floor(floatShares! * FLOAT_MIN_PCT_PER_MIN);
    minSharesReq = Math.max(MIN_SHARES_ABS, byFloat);
  } else {
    minSharesReq = 10_000; // conservative fallback if float unknown
  }
  const sharesOK  = lastVolume >= minSharesReq;
  const dollarsOK = dollarVol >= MIN_DOLLAR_VOL;
  return { ok: sharesOK && dollarsOK, minSharesReq, dollarVol };
}

/** Streaming helper */
async function say(controller: ReadableStreamDefaultController, text: string, ms = 200) {
  controller.enqueue(td.encode(text));
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

/** ─────────────────── Route ─────────────────── */
export async function POST(req: NextRequest) {
  try {
    const { symbol, thesis } = await req.json();
    if (!symbol || typeof symbol !== "string") {
      return new Response("Missing symbol", { status: 400 });
    }

    const stream = new ReadableStream({
      start: async (controller) => {
        try {
          const tNow = hhmmssET();
          await say(controller, `(${tNow} ET) ${symbol}. Taking a breath. Looking for a clean long.\n`);

          // Windows
          const scanPhase   = inScanWindowET();
          const forcePhase  = inForceWindowET();

          // Pull candles once; used in both branches when relevant
          const candles = await fetchCandles1m(symbol, 240);
          const today = yyyyMmDdET();
          const day = candles.filter((c) => isSameETDay(toET(c.date), today));

          if (!day.length) {
            await say(controller, `No fresh 1-minute bars yet. I’ll wait for the open flow.\n`);
            controller.close();
            return;
          }
          const last = day[day.length - 1];

          // Always check price + spread (both phases)
          const priceOK = last.close >= PRICE_MIN && last.close <= PRICE_MAX;
          const spreadOK = await spreadGuardOK(symbol, SPREAD_MAX_PCT);

          if (scanPhase) {
            // ───────────── Scan window tone (09:30–09:44) ─────────────
            await say(controller, `Scan window (09:30–09:44). I want quality flow, not noise.\n`);

            // Liquidity (scan only)
            const floatShares = await fetchFloatShares(symbol, last.close);
            const liq = passesBalancedLiquidityGuard(last.close, last.volume ?? 0, floatShares);

            await say(
              controller,
              `Quick checks → Price $${last.close.toFixed(2)} in [$${PRICE_MIN}–$${PRICE_MAX}]: ${priceOK ? "yes" : "no"}. Spread ≤ ${(SPREAD_MAX_PCT*100).toFixed(2)}%: ${spreadOK ? "yes" : "no"}.\n`
            );
            await say(
              controller,
              `Liquidity → last bar ${Number(last.volume ?? 0).toLocaleString()} sh, ≈ $${Math.round((last.close)*(last.volume || 0)).toLocaleString()}/min. Need ≥ ${liq.minSharesReq.toLocaleString()} sh & $${MIN_DOLLAR_VOL.toLocaleString()}/min: ${liq.ok ? "good" : "light"}.\n`
            );

            // Signals
            const orRange = computeOpeningRange(candles, today);
            const vwap    = computeSessionVWAP(candles, today);
            const vol     = computeVolumePulse(candles, today, 5);

            const m = minutesSince930ET();
            const t = clamp01((m - DECAY_START_MIN) / (DECAY_END_MIN - DECAY_START_MIN));
            const VOL_MULT_MIN = lerp(VOL_MULT_START, VOL_MULT_END, t);
            const NEAR_OR_PCT  = lerp(NEAR_OR_START,  NEAR_OR_END,  t);
            const VWAP_RECLAIM_BAND = lerp(VWAP_BAND_START, VWAP_BAND_END, t);

            const aboveVWAP = vwap != null && last.close >= vwap;
            const breakORH  = !!(orRange && last.close > orRange.high);
            const nearOR    = !!(orRange && last.close >= orRange.high * (1 - NEAR_OR_PCT));
            const vwapRecl  = !!(vwap != null && last.close >= vwap && last.low >= vwap * (1 - VWAP_RECLAIM_BAND));
            const volOK     = (vol?.mult ?? 0) >= VOL_MULT_MIN;

            await say(controller, `Levels → OR high ${orRange ? orRange.high.toFixed(2) : "n/a"}, VWAP ${vwap ? vwap.toFixed(2) : "n/a"}.\n`);
            await say(controller, `Reads → Above VWAP: ${aboveVWAP ? "yes" : "no"}. Pressing OR high: ${breakORH ? "yes" : "no"}. Near OR: ${nearOR ? "yes" : "no"}. VWAP reclaim: ${vwapRecl ? "yes" : "no"}. Volume pulse ${vol?.mult ? vol.mult.toFixed(2) : "n/a"} (need ≥ ${VOL_MULT_MIN.toFixed(2)}): ${volOK ? "ok" : "weak"}.\n`);

            const signalCount = [breakORH, nearOR, vwapRecl, volOK].filter(Boolean).length;
            const armed = priceOK && spreadOK && liq.ok && aboveVWAP && signalCount >= 2;

            if (armed) {
              const tp = last.close * (1 + TARGET_PCT);
              const sl = last.close * (1 + STOP_PCT);
              await say(controller, `This lines up. Above VWAP with ${signalCount} confirms. I’ll take strength through the highs.\n`);
              await say(controller, `Risk plan: target +10% ≈ $${tp.toFixed(2)}. Stop −5% ≈ $${sl.toFixed(2)}. Small slippage is fine; no chasing if spread widens.\n`);
            } else {
              const gaps: string[] = [];
              if (!priceOK) gaps.push("price band");
              if (!spreadOK) gaps.push("spread");
              if (!liq.ok) gaps.push("liquidity");
              if (!(vwap != null && last.close >= vwap)) gaps.push("back above VWAP");
              if (signalCount < 2) gaps.push("get 2 signals (OR break/near, VWAP reclaim, volume)");
              await say(controller, `Not yet. I need: ${gaps.join(", ")}.\n`);
            }

            const d = nowET();
            const mins = d.getHours() * 60 + d.getMinutes();
            const toForce = (9 * 60 + 45) - mins;
            if (toForce > 0) {
              await say(controller, `About ${toForce} min to 09:45. I’ll stay patient and keep reading the next bars.\n`);
            }
            if (thesis) {
              await say(controller, `Note: “${String(thesis).trim()}”. I’ll respect it only if it fits the setup.\n`);
            }
          } else if (forcePhase) {
            // ───────────── Force window tone (09:45–09:46) ─────────────
            await say(controller, `Force window (09:45–09:46). No setup required. I’ll lean on the AI pick.\n`);
            await say(controller, `Here I only care about basic safety: price band and spread. No liquidity rule.\n`);

            await say(
              controller,
              `Price $${last.close.toFixed(2)} in [$${PRICE_MIN}–$${PRICE_MAX}]: ${priceOK ? "yes" : "no"}. Spread ≤ ${(SPREAD_MAX_PCT*100).toFixed(2)}%: ${spreadOK ? "yes" : "no"}.\n`
            );

            if (priceOK && spreadOK) {
              const tp = last.close * (1 + TARGET_PCT);
              const sl = last.close * (1 + STOP_PCT);
              await say(controller, `If the AI pick is ${symbol} and we’re still flat, I’m ready to buy with a bracket.\n`);
              await say(controller, `Plan: target +10% ≈ $${tp.toFixed(2)}. Stop −5% ≈ $${sl.toFixed(2)}.\n`);
            } else {
              await say(controller, `Even in force mode I’ll skip if spread is too wide or price is out of band. Safety first.\n`);
            }

            if (thesis) {
              await say(controller, `Note: “${String(thesis).trim()}”. Good to know, but the AI pick and guards lead here.\n`);
            }
          } else {
            // ───────────── Outside both windows ─────────────
            const d = nowET();
            const mins = d.getHours() * 60 + d.getMinutes();
            if (mins < 9 * 60 + 30) {
              await say(controller, `Pre-open/early. I’ll start talking more at 09:30.\n`);
            } else if (mins > 9 * 60 + 46) {
              await say(controller, `Past the early window. I’ll defer to the main bot for exits, ratchets, and late rules.\n`);
            } else {
              await say(controller, `Transitioning window. I’m following the main bot’s timing.\n`);
            }
          }

          controller.close();
        } catch {
          controller.enqueue(td.encode("Narration error.\n"));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  } catch {
    return new Response("Bad request", { status: 400 });
  }
}
