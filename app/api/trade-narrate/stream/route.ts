// app/api/trade-narrate/stream/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest } from "next/server";
import { spreadGuardOK } from "@/lib/alpaca";

/* ───────────────────── Config (mirror bot) ───────────────────── */
const PRICE_MIN = 1;
const PRICE_MAX = 70;
const SPREAD_MAX_PCT = 0.005; // 0.50%

// Scan decay window 9:30–9:44
const DECAY_START_MIN = 0;
const DECAY_END_MIN = 14;

const VOL_MULT_START = 1.20;
const VOL_MULT_END = 1.10;
const NEAR_OR_START = 0.003;
const NEAR_OR_END = 0.0045;
const VWAP_BAND_START = 0.002;
const VWAP_BAND_END = 0.003;

// Balanced liquidity guard (SCAN ONLY — not used in force)
const MIN_SHARES_ABS = 8_000;
const FLOAT_MIN_PCT_PER_MIN = 0.0025; // 0.25%
const MIN_DOLLAR_VOL = 200_000;

// Stream pacing
const TICK_MS = 20_000; // ~every 20s
const MAX_SCAN_MINUTES = 15; // safety

/* ───────────────────── ET time helpers ───────────────────── */
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

/* ───────────────────── small utils ───────────────────── */
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const td = new TextEncoder();

function getBaseUrl(req: Request) {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = (req.headers.get("x-forwarded-proto") || "http").split(",")[0].trim();
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim();
  return `${proto}://${host}`;
}
async function say(controller: ReadableStreamDefaultController, text: string, ms = 0) {
  controller.enqueue(td.encode(text));
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

/* ───────────────────── Market data helpers ───────────────────── */
type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };
type SnapStock = {
  ticker: string;
  price?: number | null;
  changesPercentage?: number | null;
  volume?: number | null;
  avgVolume?: number | null;
  marketCap?: number | null;
  float?: number | null;
};

async function fetchCandles1m(base: string, symbol: string, limit = 240): Promise<Candle[]> {
  const res = await fetch(
    `${base}/api/fmp/candles?symbol=${encodeURIComponent(symbol)}&interval=1min&limit=${limit}`,
    { cache: "no-store" }
  );
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
  let pvSum = 0,
    volSum = 0;
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

/* Float lookups (safe fallbacks) */
async function fetchFloatShares(base: string, symbol: string, lastPrice: number | null): Promise<number | null> {
  try {
    const r = await fetch(`${base}/api/fmp/float?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const f = Number(j?.float ?? j?.floatShares ?? j?.freeFloat);
      if (Number.isFinite(f) && f > 0) return f;
    }
  } catch {}
  try {
    const r2 = await fetch(`${base}/api/fmp/profile?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    if (r2.ok) {
      const j2 = await r2.json();
      const arr = Array.isArray(j2) ? j2 : Array.isArray(j2?.profile) ? j2.profile : [];
      const row = arr[0] || j2 || {};
      const f = Number(row.floatShares ?? row.sharesFloat ?? row.freeFloat);
      if (Number.isFinite(f) && f > 0) return f;
      const so = Number(row.sharesOutstanding ?? row.mktCapShares);
      if (Number.isFinite(so) && so > 0) return Math.floor(so * 0.8);
    }
  } catch {}
  try {
    const r3 = await fetch(`${base}/api/fmp/quote?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
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

/* Balanced liquidity (SCAN ONLY) */
type LiquidityCheck = { ok: boolean; minSharesReq: number; dollarVol: number };
function passesBalancedLiquidityGuard(lastClose: number, lastVolume: number, floatShares: number | null): LiquidityCheck {
  const dollarVol = lastClose * lastVolume;
  let minSharesReq = MIN_SHARES_ABS;
  if (Number.isFinite(Number(floatShares)) && floatShares! > 0) {
    const byFloat = Math.floor(floatShares! * FLOAT_MIN_PCT_PER_MIN);
    minSharesReq = Math.max(MIN_SHARES_ABS, byFloat);
  } else {
    minSharesReq = 10_000; // conservative fallback if float unknown
  }
  const sharesOK = lastVolume >= minSharesReq;
  const dollarsOK = dollarVol >= MIN_DOLLAR_VOL;
  return { ok: sharesOK && dollarsOK, minSharesReq, dollarVol };
}

/* Safe spread check (never throws) */
async function safeSpreadCheck(symbol: string) {
  try {
    const ok = await spreadGuardOK(symbol, SPREAD_MAX_PCT);
    return { pass: ok, note: "" };
  } catch {
    return { pass: false, note: " (couldn’t verify spread)" };
  }
}

/* Snapshot + AI picks */
async function getSnapshot(base: string): Promise<{ stocks: SnapStock[]; updatedAt: string } | null> {
  try {
    const r = await fetch(`${base}/api/stocks/snapshot`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return {
      stocks: Array.isArray(j?.stocks) ? j.stocks : [],
      updatedAt: j?.updatedAt || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
function tokenizeTickers(txt: string): string[] {
  if (!txt) return [];
  return Array.from(new Set((txt.toUpperCase().match(/\b[A-Z]{1,5}\b/g) || [])));
}
function parseTwoPicksFromResponse(rJson: any, allowed?: string[]): string[] {
  const allowSet = new Set((allowed || []).map((s) => s.toUpperCase()));
  const out: string[] = [];
  // structured
  if (Array.isArray(rJson?.picks)) {
    for (const s of rJson.picks) {
      const u = String(s || "").toUpperCase();
      if (/^[A-Z][A-Z0-9.\-]*$/.test(u) && (!allowSet.size || allowSet.has(u))) out.push(u);
      if (out.length >= 2) return out;
    }
  }
  // common fields
  const fields = [rJson?.ticker, rJson?.symbol, rJson?.pick, rJson?.Pick, rJson?.data?.ticker, rJson?.data?.symbol];
  for (const f of fields) {
    const u = typeof f === "string" ? f.toUpperCase() : "";
    if (/^[A-Z][A-Z0-9.\-]*$/.test(u) && (!allowSet.size || allowSet.has(u)) && !out.includes(u)) out.push(u);
    if (out.length >= 2) return out;
  }
  // text scrape
  let txt = String(rJson?.recommendation ?? rJson?.text ?? rJson?.message ?? "");
  txt = txt.replace(/[*_`~]/g, "").replace(/^-+\s*/gm, "");
  const toks = tokenizeTickers(txt).filter((t) => !allowSet.size || allowSet.has(t));
  for (const t of toks) {
    if (!out.includes(t)) out.push(t);
    if (out.length >= 2) break;
  }
  return out;
}

/* ──────────────── Discriminated union for TS narrowing ──────────────── */
type SignalReadOK = {
  ok: true;
  price: number;
  priceOK: boolean;
  spreadOK: boolean;
  spreadNote: string;
  liq: LiquidityCheck;
  orHigh: number | null;
  vwap: number | null;
  volMult: number | null;
  VOL_MULT_MIN: number;
  NEAR_OR_PCT: number;
  VWAP_RECLAIM_BAND: number;
  aboveVWAP: boolean;
  breakORH: boolean;
  nearOR: boolean;
  vwapRecl: boolean;
  volOK: boolean;
  signalCount: number;
  armedMomentum: boolean;
};
type SignalReadFail = { ok: false; reason: "no_day_candles" | "error" };

/* Evaluate one symbol for a clear, English explanation */
async function readSignalsForNarration(base: string, symbol: string): Promise<SignalReadOK | SignalReadFail> {
  try {
    const today = yyyyMmDdET();
    const candles = await fetchCandles1m(base, symbol, 240);
    const day = candles.filter((c) => isSameETDay(toET(c.date), today));
    if (!day.length) return { ok: false, reason: "no_day_candles" };

    const last = day[day.length - 1];
    const priceOK = last.close >= PRICE_MIN && last.close <= PRICE_MAX;

    // dynamic thresholds (decay)
    const m = minutesSince930ET();
    const t = clamp01((m - DECAY_START_MIN) / (DECAY_END_MIN - DECAY_START_MIN));
    const VOL_MULT_MIN = lerp(VOL_MULT_START, VOL_MULT_END, t);
    const NEAR_OR_PCT = lerp(NEAR_OR_START, NEAR_OR_END, t);
    const VWAP_RECLAIM_BAND = lerp(VWAP_BAND_START, VWAP_BAND_END, t);

    const { pass: spreadOK, note: spreadNote } = await safeSpreadCheck(symbol);

    // Liquidity (scan only)
    const floatShares = await fetchFloatShares(base, symbol, last.close);
    const liq = passesBalancedLiquidityGuard(last.close, last.volume ?? 0, floatShares);

    // Levels + signals
    const orRange = computeOpeningRange(candles, today);
    const vwap = computeSessionVWAP(candles, today);
    const vol = computeVolumePulse(candles, today, 5);

    const aboveVWAP = vwap != null && last.close >= vwap;
    const breakORH = !!(orRange && last.close > orRange.high);
    const nearOR = !!(orRange && last.close >= orRange.high * (1 - NEAR_OR_PCT));
    const vwapRecl = !!(vwap != null && last.close >= vwap && last.low >= vwap * (1 - VWAP_RECLAIM_BAND));
    const volOK = (vol?.mult ?? 0) >= VOL_MULT_MIN;

    const signalCount = [breakORH, nearOR, vwapRecl, volOK].filter(Boolean).length;
    const armedMomentum = !!(aboveVWAP && signalCount >= 2);

    return {
      ok: true,
      price: last.close,
      priceOK,
      spreadOK,
      spreadNote,
      liq,
      orHigh: orRange?.high ?? null,
      vwap,
      volMult: vol?.mult ?? null,
      VOL_MULT_MIN,
      NEAR_OR_PCT,
      VWAP_RECLAIM_BAND,
      aboveVWAP,
      breakORH,
      nearOR,
      vwapRecl,
      volOK,
      signalCount,
      armedMomentum,
    };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/* ───────────────────── Route ───────────────────── */
export async function POST(req: NextRequest) {
  try {
    // Optional: allow a custom opening line/thesis, but we auto-drive narration.
    const { note } = await req.json().catch(() => ({ note: "" }));

    const base = getBaseUrl(req);

    const stream = new ReadableStream({
      start: async (controller) => {
        try {
          const t = hhmmssET();
          const greet = inScanWindowET() ? "good morninggg" : "hello";
          await say(controller, `(${t} ET) ${greet} — let's trade smart.\n`);

          // If we are before 9:30, set context and exit quickly.
          if (!inScanWindowET() && !inForceWindowET()) {
            await say(controller, `I’ll start live commentary between 09:30–09:45 ET. Check back at the open.\n`);
            controller.close();
            return;
          }

          if (note && typeof note === "string") {
            await say(controller, `Note received: “${note.trim()}”. I’ll consider it if it aligns with a clean setup.\n`);
          }

          // SCAN LOOP: talk continuously until 09:45
          let scanTicks = 0;
          let announcedTopOnce = false;

          while (inScanWindowET() && scanTicks < Math.ceil((MAX_SCAN_MINUTES * 60_000) / TICK_MS)) {
            scanTicks++;

            const snap = await getSnapshot(base);
            const top = (snap?.stocks || []).slice(0, 8);
            if (!top.length) {
              await say(controller, `Waiting for the top gainers list to populate...\n`, TICK_MS);
              continue;
            }

            if (!announcedTopOnce) {
              const names = top.map((s) => s.ticker).join(", ");
              await say(controller, `Scanning top 8 gainers: ${names}.\n`);
              announcedTopOnce = true;
            }

            // Ask the AI for the two picks among top 8
            let picks: string[] = [];
            try {
              const r = await fetch(`${base}/api/recommendation`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ stocks: top, forcePick: true, requirePick: true }),
                cache: "no-store",
              });
              if (r.ok) {
                const j = await r.json();
                picks = parseTwoPicksFromResponse(j, top.map((s) => s.ticker)).slice(0, 2);
              }
            } catch {}

            if (!picks.length) {
              await say(controller, `AI hasn’t locked two names yet. Keeping an eye on the tape...\n`, TICK_MS);
              continue;
            }

            if (picks.length === 1) {
              await say(controller, `AI primary pick: ${picks[0]}. Secondary is still loading...\n`);
            } else {
              await say(controller, `AI short-list: ${picks[0]} (primary) and ${picks[1]} (secondary).\n`);
            }

            // Explain the “why” for each pick in plain English
            for (const sym of picks) {
              const read = await readSignalsForNarration(base, sym);
              if (!read.ok) {
                await say(controller, `• ${sym}: no fresh intraday bars yet; skipping analysis for now.\n`);
                continue;
              }

              const parts: string[] = [];
              parts.push(`• ${sym}: $${read.price.toFixed(2)} — `);

              // Quick checklist
              parts.push(`price ${read.priceOK ? "in band" : "out of band"}, spread ${read.spreadOK ? "tight" : "too wide"}${read.spreadNote || ""}`);

              const liqStr = `liq ${read.liq.ok ? "OK" : "light"} (need ≥ ${read.liq.minSharesReq.toLocaleString()} sh & $${MIN_DOLLAR_VOL.toLocaleString()}/min)`;
              parts.push(`, ${liqStr}.`);

              // Levels + signals
              const levels: string[] = [];
              if (read.orHigh != null) levels.push(`ORH ${read.orHigh.toFixed(2)}`);
              if (read.vwap != null) levels.push(`VWAP ${read.vwap.toFixed(2)}`);
              if (levels.length) parts.push(` Levels: ${levels.join(", ")}.`);

              const sigs: string[] = [];
              if (read.aboveVWAP) sigs.push("above VWAP");
              if (read.breakORH) sigs.push("pushing OR high");
              if (read.nearOR) sigs.push(`near OR (${(read.NEAR_OR_PCT * 100).toFixed(2)}% band)`);
              if (read.vwapRecl) sigs.push(`VWAP reclaim (${(read.VWAP_RECLAIM_BAND * 100).toFixed(2)}% hold)`);
              if (read.volMult != null) sigs.push(`vol pulse ${read.volMult.toFixed(2)}× (need ≥ ${read.VOL_MULT_MIN.toFixed(2)}×)`);

              if (sigs.length) parts.push(` Signals: ${sigs.join(", ")}.`);

              // Decision phrasing
              if (read.priceOK && read.spreadOK && read.liq.ok && read.armedMomentum) {
                parts.push(` Read: **momentum armed** (above VWAP + ${read.signalCount} confirms). This is tradable if it’s the chosen one.`);
              } else {
                const needs: string[] = [];
                if (!read.priceOK) needs.push("price in band");
                if (!read.spreadOK) needs.push("tighter spread");
                if (!read.liq.ok) needs.push("more liquidity");
                if (!(read.aboveVWAP && read.signalCount >= 2)) needs.push("above VWAP + ≥2 signals");
                if (needs.length) parts.push(` Needs: ${needs.join(", ")}.`);
              }

              await say(controller, parts.join(""), 0);
              await say(controller, `\n`);
            }

            // Soft pacing between updates
            await say(controller, "", TICK_MS);
          }

          // Force window narration (09:45–09:46)
          if (inForceWindowET()) {
            await say(
              controller,
              `(${hhmmssET()} ET) Force window. If still flat, I’ll lean on the AI pick with safety checks only (price band & spread). No liquidity rule here.\n`
            );
          }

          await say(controller, `(${hhmmssET()} ET) Early window commentary complete.\n`);
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
