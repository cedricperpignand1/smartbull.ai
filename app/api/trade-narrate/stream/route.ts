export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest } from "next/server";
import OpenAI from "openai";
import { spreadGuardOK } from "@/lib/alpaca";

/* ───────────────────── OpenAI config ───────────────────── */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const NARRATOR_MODEL = process.env.NARRATOR_MODEL?.trim() || "gpt-4o-mini";
const NARRATOR_TEMP = Number(process.env.NARRATOR_TEMP ?? 0.6);
const NARRATOR_MAX_TOKENS = Number(process.env.NARRATOR_MAX_TOKENS ?? 120);

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
const TICK_MS = 20_000;             // ~every 20s
const MAX_SCAN_MINUTES = 15;        // safety
const DETAIL_EVERY_N_TICKS = 3;     // full detail every 3 ticks

/* ───────────────────── “Human” cadence ───────────────────── */
const THINK_MIN_MS = 450;
const THINK_MAX_MS = 1200;
const td = new TextEncoder();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const think = (ms?: number) =>
  sleep(ms ?? (THINK_MIN_MS + Math.random() * (THINK_MAX_MS - THINK_MIN_MS)));

async function say(controller: ReadableStreamDefaultController, text: string, msAfter = 0, preThink = true) {
  if (preThink) await think();
  controller.enqueue(td.encode(text));
  if (msAfter > 0) await sleep(msAfter);
}

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
function isExactly930ET() {
  const d = nowET();
  return d.getHours() === 9 && d.getMinutes() === 30;
}

/* ───────────────────── small utils ───────────────────── */
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/* ───────────────────── Casual persona helpers ───────────────────── */
const persona = {
  emojis: ["🚀", "📈", "☕️", "🤝", "🧠", "💪", "🦅", "🎯"],
  quips: [
    "If spreads widen, we don’t chase — we sip coffee. ☕️",
    "Volume talks, we listen, then act.",
    "Above VWAP? Buyers said ‘dibs’.",
    "Opening range highs are just doors. 🚪",
    "Tape says ‘maybe’. I say ‘prove it’.",
  ],
  forceNotes: [
    "Force window = seatbelts on, risk guards first. 🛡️",
    "If still flat into :45, I’ll lean on the AI — tight checks only. 🧠",
  ],
};
const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
let riffCounter = 0;
function riff() {
  riffCounter++;
  if (riffCounter % 2 === 0) return ` ${pick(persona.quips)}\n`;
  return "\n";
}

function getBaseUrl(req: Request) {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = (req.headers.get("x-forwarded-proto") || "http").split(",")[0].trim();
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim();
  return `${proto}://${host}`;
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
    const orRange = computeOpeningRange(candles, yyyyMmDdET());
    const vwap = computeSessionVWAP(candles, yyyyMmDdET());
    const vol = computeVolumePulse(candles, yyyyMmDdET(), 5);

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

/* ───────────────────── OpenAI narration helper ───────────────────── */
/** Streams a short, polished narration built from your structured signals. */
async function streamOpenAINarration(
  controller: ReadableStreamDefaultController,
  payload: {
    symbol: string;
    timeET: string;
    read: SignalReadOK;
    allowEmoji: boolean;
  }
) {
  if (!process.env.OPENAI_API_KEY) {
    // No key configured — quietly skip
    return false;
  }

  const system = [
    "You are a concise day-trading narrator for a scalping bot.",
    "Goal: craft 1–2 short sentences that sound human and confident, but not promotional.",
    "Always include the SYMBOL and last PRICE like: ABCD $3.42.",
    "Mention only the most important signals (VWAP, opening range, volume pulse, spread, liquidity).",
    "If setup is incomplete, say what’s missing succinctly (e.g., needs tighter spread, more liquidity, or VWAP reclaim).",
    "No advice/disclaimers. Keep it crisp. Avoid filler. Max ~220 characters.",
    "If allowEmoji=true, you may add at most one relevant emoji at the end; otherwise no emojis.",
  ].join(" ");

  const { symbol, timeET, read, allowEmoji } = payload;

  const user = {
    timeET,
    symbol,
    price: Number(read.price.toFixed(2)),
    priceOK: read.priceOK,
    spreadOK: read.spreadOK,
    spreadNote: read.spreadNote,
    liquidityOK: read.liq.ok,
    minSharesRequired: read.liq.minSharesReq,
    dollarVolMin: MIN_DOLLAR_VOL,
    orHigh: read.orHigh,
    vwap: read.vwap,
    aboveVWAP: read.aboveVWAP,
    breakORH: read.breakORH,
    nearOR: read.nearOR,
    vwapReclaim: read.vwapRecl,
    volMult: read.volMult,
    volNeeded: read.VOL_MULT_MIN,
    signalCount: read.signalCount,
    armedMomentum: read.armedMomentum,
    allowEmoji,
  };

  try {
    const stream = await openai.chat.completions.create({
      model: NARRATOR_MODEL,
      temperature: NARRATOR_TEMP,
      max_tokens: NARRATOR_MAX_TOKENS,
      stream: true,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content:
            "Turn this JSON into 1–2 sentences. Return plaintext only:\n" +
            JSON.stringify(user),
        },
      ],
    });

    // pipe tokens → client
    for await (const part of stream) {
      const delta = part.choices?.[0]?.delta?.content || "";
      if (delta) controller.enqueue(td.encode(delta));
    }
    controller.enqueue(td.encode("\n"));
    return true;
  } catch {
    // If OpenAI fails, we silently fall back to template narration
    return false;
  }
}

/* ───────────────────── Route ───────────────────── */
export async function POST(req: NextRequest) {
  try {
    const { note } = await req.json().catch(() => ({ note: "" }));
    const base = getBaseUrl(req);

    const stream = new ReadableStream({
      start: async (controller) => {
        try {
          // Opening line with time + *only* say "good morninggg" at 09:30 ET
          const t = hhmmssET();
          const greeting = isExactly930ET()
            ? "good morninggg ☕️"
            : (inScanWindowET() ? "hey — keeping it chill, watching the open." : "hey — I’ll jump in at 09:30 ET.");
          await say(controller, `(${t} ET) ${greeting}\n`);

          if (!inScanWindowET() && !inForceWindowET()) {
            await say(controller, `Live commentary runs 09:30–09:45 ET. I’ll save the words till the bell. 🛎️\n`);
            controller.close();
            return;
          }

          if (note && typeof note === "string" && note.trim()) {
            await say(controller, `Noted: “${note.trim()}”. If it fits the setup, we’ll work it in. 🤝\n`);
          }

          // SCAN LOOP
          let scanTicks = 0;
          let announcedTopOnce = false;

          while (inScanWindowET() && scanTicks < Math.ceil((MAX_SCAN_MINUTES * 60_000) / TICK_MS)) {
            scanTicks++;
            const doDetailed = scanTicks % DETAIL_EVERY_N_TICKS === 1;

            const snap = await getSnapshot(base);
            const top = (snap?.stocks || []).slice(0, 8);

            if (!top.length) {
              if (doDetailed) await say(controller, `Waiting for top gainers to populate… ${pick(persona.emojis)}\n`);
              await sleep(TICK_MS);
              continue;
            }

            if (!announcedTopOnce && doDetailed) {
              const names = top.map((s) => s.ticker).join(", ");
              await say(controller, `Scanning top 8: ${names}. ${pick(persona.emojis)}${riff()}`);
              announcedTopOnce = true;
            }

            // Ask your /api/recommendation for 1–2 symbols to narrate
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
              if (doDetailed) {
                await say(controller, `AI hasn’t locked two names yet. Watching the tape… ${pick(persona.emojis)}\n`);
              }
              await sleep(TICK_MS);
              continue;
            }

            if (doDetailed) {
              if (picks.length === 1) {
                await say(controller, `Primary: ${picks[0]}. Secondary loading… 🧠\n`);
              } else {
                await say(controller, `Short-list: ${picks[0]} (primary), ${picks[1]} (secondary). ${pick(persona.emojis)}\n`);
              }
            }

            // Detailed narration with OpenAI (fallback to template)
            if (doDetailed) {
              for (const sym of picks) {
                const read = await readSignalsForNarration(base, sym);
                if (!read.ok) {
                  await say(controller, `• ${sym}: no fresh intraday bars yet; skipping for now. 🧃\n`);
                  continue;
                }

                // Try LLM narration first
                const usedLLM = await streamOpenAINarration(controller, {
                  symbol: sym,
                  timeET: hhmmssET(),
                  read,
                  allowEmoji: true,
                });

                if (!usedLLM) {
                  // Fallback to your concise template if model unavailable
                  const parts: string[] = [];
                  parts.push(`• ${sym}: $${read.price.toFixed(2)} — `);
                  parts.push(
                    `price ${read.priceOK ? "in band" : "out of band"}, spread ${read.spreadOK ? "tight" : "wide"}${read.spreadNote || ""}`
                  );
                  const liqStr = `liq ${read.liq.ok ? "OK" : "light"} (need ≥ ${read.liq.minSharesReq.toLocaleString()} sh & $${MIN_DOLLAR_VOL.toLocaleString()}/min)`;
                  parts.push(`, ${liqStr}.`);

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

                  if (read.priceOK && read.spreadOK && read.liq.ok && read.armedMomentum) {
                    parts.push(` Read: momentum armed (above VWAP + ${read.signalCount} confirms). Comfortable to act. 🚀`);
                  } else {
                    const needs: string[] = [];
                    if (!read.priceOK) needs.push("price in band");
                    if (!read.spreadOK) needs.push("tighter spread");
                    if (!read.liq.ok) needs.push("more liquidity");
                    if (!(read.aboveVWAP && read.signalCount >= 2)) needs.push("above VWAP + ≥2 signals");
                    if (needs.length) parts.push(` Needs: ${needs.join(", ")}. No FOMO — let it come to us. 😎`);
                  }
                  await say(controller, parts.join("") + ` ${pick(persona.emojis)}${riff()}`);
                }
              }
            }

            await sleep(TICK_MS);
          }

          // Force window narration (09:45–09:46)
          if (inForceWindowET()) {
            await say(
              controller,
              `(${hhmmssET()} ET) Force window. If we’re still flat, I’ll lean on the AI with safety checks only (price band & spread). ${pick(
                persona.forceNotes
              )}\n`
            );
          }

          await say(controller, `(${hhmmssET()} ET) Early window done. Trade clean, hydrate, respect stops. 💧🎯\n`);
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
