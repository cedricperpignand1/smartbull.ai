/* eslint-disable @typescript-eslint/no-explicit-any */
// app/api/ai-chat/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import OpenAI from "openai";
import { prisma } from "@/lib/prisma";
import { spreadGuardOK } from "@/lib/alpaca";

/* ───────────────── OpenAI (optional) ───────────────── */
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const CHAT_MODEL = process.env.CHAT_MODEL?.trim() || "gpt-4o-mini";
const CHAT_TEMP = Number(process.env.CHAT_TEMP ?? 0.6);
const CHAT_MAX_TOKENS = Number(process.env.CHAT_MAX_TOKENS ?? 240);

async function safeChat(messages: { role: "system" | "user" | "assistant"; content: string }[]) {
  if (!openai) return null;
  try {
    const res = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: CHAT_TEMP,
      max_tokens: CHAT_MAX_TOKENS,
      messages,
    });
    return res.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

async function maybePolishReply(draft: string, facts?: any, opts: { maxLen?: number } = {}) {
  if (!openai) return draft;
  const maxLen = opts.maxLen ?? 600;
  if (draft.length > maxLen || draft.split("\n").length > 6) return draft;
  const system = "You are a concise trading assistant. Rewrite the user's draft answer into clearer, smoother English without adding new facts. Keep numbers and tickers exact. Prefer 1–3 short sentences. No advice or hype.";
  const user = (facts ? `Facts (JSON):\n${JSON.stringify(facts)}\n\n` : "") + `Draft answer:\n${draft}\n\nReturn plaintext only.`;
  const out = await safeChat([{ role: "system", content: system }, { role: "user", content: user }]);
  return out || draft;
}

/* ───────────────── ET helpers ───────────────── */
function firstSundayUTC(year: number, monthIndex: number) {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  const dow = d.getUTCDay();
  const add = (7 - dow) % 7;
  return 1 + add;
}
function secondSundayUTC(year: number, monthIndex: number) {
  return firstSundayUTC(year, monthIndex) + 7;
}
function isDST_US_Eastern(utc: Date): boolean {
  const y = utc.getUTCFullYear();
  const start = Date.UTC(y, 2, secondSundayUTC(y, 2), 7, 0, 0);
  const end = Date.UTC(y, 10, firstSundayUTC(y, 10), 6, 0, 0);
  const t = utc.getTime();
  return t >= start && t < end;
}
function toETParts(utc: Date) {
  const offsetMin = isDST_US_Eastern(utc) ? -240 : -300;
  const shifted = new Date(utc.getTime() + offsetMin * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  const ss = String(shifted.getUTCSeconds()).padStart(2, "0");
  return { ymd: `${y}-${m}-${d}`, hms: `${hh}:${mm}:${ss}` };
}
function startOfETDayUTC(utcInstant: Date): Date {
  const parts = toETParts(utcInstant);
  const [Y, M, D] = parts.ymd.split("-").map(Number);
  const noonUTC = new Date(Date.UTC(Y, M - 1, D, 12));
  const offsetMin = isDST_US_Eastern(utcInstant) ? 240 : 300;
  return new Date(noonUTC.getTime() - 12 * 60 * 60 * 1000 + offsetMin * 60_000);
}
function endOfETDayUTC(utcInstant: Date): Date {
  const start = startOfETDayUTC(utcInstant);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}

/** Parse ET date range from message. */
function parseDateRangeETFromMessage(msg: string, nowUTC: Date): { startUTC: Date; endUTC: Date; label: string } {
  const lower = msg.toLowerCase();

  const on = lower.match(/\b(on\s+)?(\d{4})[-/](\d{2})[-/](\d{2})\b/);
  if (on) {
    const Y = Number(on[2]), M = Number(on[3]), D = Number(on[4]);
    const anchor = new Date(Date.UTC(Y, M - 1, D, 12));
    return { startUTC: startOfETDayUTC(anchor), endUTC: endOfETDayUTC(anchor), label: `${Y}-${String(M).padStart(2,"0")}-${String(D).padStart(2,"0")}` };
  }

  const between = lower.match(/\bbetween\s+(\d{4})[-/](\d{2})[-/](\d{2})\s+(and|to)\s+(\d{4})[-/](\d{2})[-/](\d{2})\b/);
  if (between) {
    const Y1 = Number(between[1]), M1 = Number(between[2]), D1 = Number(between[3]);
    const Y2 = Number(between[5]), M2 = Number(between[6]), D2 = Number(between[7]);
    const a = new Date(Date.UTC(Y1, M1 - 1, D1, 12));
    const b = new Date(Date.UTC(Y2, M2 - 1, D2, 12));
    return { startUTC: startOfETDayUTC(a), endUTC: endOfETDayUTC(b), label: `${Y1}-${String(M1).padStart(2,"0")}-${String(D1).padStart(2,"0")} → ${Y2}-${String(M2).padStart(2,"0")}-${String(D2).padStart(2,"0")}` };
  }

  const lastX = lower.match(/\blast\s+(\d{1,2})\s*(day|days|week|weeks)\b/);
  if (lastX) {
    const n = Number(lastX[1]);
    const unit = lastX[2].startsWith("week") ? "week" : "day";
    const days = unit === "week" ? n * 7 : n;
    const end = endOfETDayUTC(nowUTC);
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000 + 1);
    return { startUTC: start, endUTC: end, label: `last ${n} ${unit}${n>1?"s":""}` };
  }

  if (/\bthis week\b/.test(lower)) {
    const todayStart = startOfETDayUTC(nowUTC);
    const etAnchor = new Date(todayStart.getTime() + 12 * 60 * 60 * 1000);
    const dow = new Date(etAnchor).getUTCDay();
    const daysFromMon = (dow + 6) % 7;
    const start = new Date(todayStart.getTime() - daysFromMon * 24 * 60 * 60 * 1000);
    const end = endOfETDayUTC(nowUTC);
    return { startUTC: start, endUTC: end, label: "this week" };
  }

  if (/\bthis month\b/.test(lower)) {
    const parts = toETParts(nowUTC);
    const [Y, M] = parts.ymd.split("-").map(Number);
    const start = startOfETDayUTC(new Date(Date.UTC(Y, M - 1, 1, 12)));
    const firstNext = new Date(Date.UTC(Y, M, 1, 12));
    const lastDay = new Date(firstNext.getTime() - 24 * 60 * 60 * 1000);
    return { startUTC: start, endUTC: endOfETDayUTC(lastDay), label: "this month" };
  }

  if (/\byesterday\b/.test(lower)) {
    const todayStart = startOfETDayUTC(nowUTC);
    return { startUTC: new Date(todayStart.getTime() - 24 * 60 * 60 * 1000), endUTC: new Date(todayStart.getTime() - 1), label: "yesterday" };
  }

  return { startUTC: startOfETDayUTC(nowUTC), endUTC: endOfETDayUTC(nowUTC), label: "today" };
}

/* ───────────────── Types ───────────────── */
type DbTrade = {
  id: number;
  side: "BUY" | "SELL" | string;
  ticker: string;
  price: any;
  shares: number;
  at: Date;
  filledAt?: Date | null;
  filledPrice?: any | null;
};
type DbPos = {
  id: number;
  ticker: string;
  entryPrice: any;
  shares: number;
  entryAt: Date;
  open: boolean;
  exitPrice?: any | null;
  exitAt?: Date | null;
};
type DbReco = {
  id: number;
  ticker: string;
  price: any;
  at: Date;
  explanation?: string | null;
};

/* ───────────────── Math/format ───────────────── */
type Lot = { qty: number; cost: number };
function asNumber(x: any): number {
  if (x == null) return 0;
  if (typeof x === "number") return x;
  if (typeof x === "string") return Number(x);
  if (typeof x === "object" && "toNumber" in x) return (x as any).toNumber();
  return Number(x);
}
function pct(a: number, b: number) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return (a - b) / b;
}
function realizedFIFO(tradesAsc: DbTrade[]): number {
  const lots: Lot[] = [];
  let realized = 0;
  for (const t of tradesAsc) {
    const p = asNumber(t.price);
    const side = String(t.side).toUpperCase();
    if (side === "BUY") lots.push({ qty: t.shares, cost: p });
    else if (side === "SELL") {
      let remain = t.shares;
      while (remain > 0 && lots.length) {
        const lot = lots[0];
        const take = Math.min(lot.qty, remain);
        realized += (p - lot.cost) * take;
        lot.qty -= take;
        remain -= take;
        if (lot.qty === 0) lots.shift();
      }
    }
  }
  return realized;
}
function realizedForTicker(tradesAsc: DbTrade[], ticker: string) {
  const rows = tradesAsc.filter(t => t.ticker.toUpperCase() === ticker.toUpperCase());
  return realizedFIFO(rows);
}
const money = (n: number) => (n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`);

/* ───────────────── Tone helpers ───────────────── */
const tone = {
  flat: () => "I’m flat right now.",
  holding: (pos: DbPos) => `Currently holding ${pos.shares} ${pos.ticker} @ $${asNumber(pos.entryPrice).toFixed(2)}.`,
  fun: (s: string) => `Alrighty — ${s} 🙂`,
};

/* ───────────────── Intent ───────────────── */
type Intent =
  | "what_traded"
  | "pnl"
  | "in_position"
  | "why_trade"
  | "why_pick"
  | "sell_price"
  | "entry_price"
  | "status"
  | "why_no_trade" // ← NEW
  | "help";

// More robust, order-agnostic P&L detection
function isPnlIntent(m: string) {
  return (
    /\bp&?l\b/.test(m) ||
    /\b(profit|profits|gain|gains|loss|losses)\b/.test(m) ||
    /\b(green|red)\b/.test(m) ||
    /\bhow\s+much\s+(money|profit)\b/.test(m) ||
    /\b(did|do).*(make|made|lose|lost).*(money|profit)\b/.test(m) ||
    /\b(money|profit).*(did|do).*(make|made|lose|lost)\b/.test(m)
  );
}

function isWhyNoTradeIntent(m: string) {
  return /(why|how).*(no\s*trade|didn'?t\s*(trade|get in|enter)|miss(ed)?\s*(a\s*)?trade|didn'?t\s*get\s*filled|no\s*entry)/i.test(m);
}

function parseIntent(q: string): Intent {
  const m = q.toLowerCase();

  if (/\b(exit|sell|sold|selled|close|closed|get out|got out|take profit|tp)\b/.test(m) &&
      /\b(price|avg|average|at|fill|fills?)\b/.test(m)) return "sell_price";

  if ((/\b(buy|bought|enter|entered|entry|get in|got in|added|add)\b/.test(m) &&
       /\b(price|avg|average|cost|fill|fills?)\b/.test(m)) ||
      /\b(average cost|avg cost|avg entry|average entry)\b/.test(m)) return "entry_price";

  if (isWhyNoTradeIntent(q)) return "why_no_trade"; // ← NEW

  if (/(why).*(trade|traded|buy|bought|sell|sold|enter|entry|took|take|long|short)/.test(m)) return "why_trade";

  if (/(what|which).*(trade|trades|traded|tickers?)/.test(m)) return "what_traded";
  if (isPnlIntent(m)) return "pnl";
  if (/(are|am|you).*(in|holding).*(position)|open position/.test(m)) return "in_position";
  if (/(why).*(ai|bot).*(pick|choose|chose|selected?)/.test(m)) return "why_pick";
  if (/help|what can you do|commands?/.test(m)) return "help";
  return "status";
}

/* ───────────────── Ticker extraction ───────────────── */
// Expanded stopwords to avoid false tickers like MUCH, MONEY, etc.
const STOPWORDS = new Set([
  "WHY","WHAT","WHEN","WHERE","WHO","HOW",
  "TODAY","YESTERDAY","TOMORROW","THIS","WEEK","MONTH","YEAR",
  "DID","DO","WE","YOU","YOUR","IT","AT","IN","ON","WITH","PLEASE","THANK","THANKS","HELLO",
  "MUCH","MONEY","MAKE","MADE","LOSE","LOST",
  "TRADE","TRADES","TRADED","BUY","BOUGHT","SELL","SOLD","ENTRY","EXIT",
  "PRICE","AVERAGE","AVG","COST","FILL","FILLS","OPEN","POSITION","ABOUT"
]);

function extractCandidates(msg: string) {
  const text = msg ?? "";
  const dollar = [...text.matchAll(/\$([A-Za-z]{1,5})(?:\.[A-Za-z]{1,2})?\b/g)]
    .map(m => m[1].toUpperCase())
    .filter(t => !STOPWORDS.has(t));
  const bare = [...text.matchAll(/\b([A-Za-z]{1,5})(?:\.[A-Za-z]{1,2})?\b/g)]
    .map(m => m[1].toUpperCase())
    .filter(t => !STOPWORDS.has(t) && !dollar.includes(t));
  return { dollar, bare };
}

/** Choose ticker from message and context. */
function chooseTickerFromContext(
  msg: string,
  trades: DbTrade[],
  opts: { requireTraded?: boolean; allowBare?: boolean } = { requireTraded: true, allowBare: true }
): string | null {
  const traded = Array.from(new Set(trades.map(r => r.ticker.toUpperCase())));
  const tradedSet = new Set(traded);
  const { dollar, bare } = extractCandidates(msg);

  // Prefer $TICKER always
  for (const t of dollar) {
    if (!opts.requireTraded) return t;
    if (tradedSet.has(t)) return t;
  }

  // Only allow bare tokens if explicitly enabled (to avoid MU​CH/MONEY etc.)
  if (opts.allowBare) {
    for (const t of bare) {
      if (!opts.requireTraded) return t;
      if (tradedSet.has(t)) return t;
    }
  }

  if (opts.requireTraded && traded.length === 1) return traded[0];
  return null;
}

/* ───────────────── Internal API / market helpers ───────────────── */
function getBaseUrl(req: Request) {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = (req.headers.get("x-forwarded-proto") || "http").split(",")[0].trim();
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

// NEW: fetch current bot tick (to read debug/info for explanations)
async function fetchBotTick(base: string): Promise<any | null> {
  try {
    const r = await fetch(`${base}/api/bot/tick`, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };
type QuoteLite = { price?: number | null; avgVolume?: number | null; marketCap?: number | null; changesPercentage?: number | null };

async function fetchCandles1m(base: string, symbol: string, limit = 360): Promise<Candle[]> {
  try {
    const res = await fetch(`${base}/api/fmp/candles?symbol=${encodeURIComponent(symbol)}&interval=1min&limit=${limit}`, { cache: "no-store" });
    if (!res.ok) return [];
    const j = await res.json();
    const arr = Array.isArray(j?.candles) ? j.candles : [];
    return arr.map((c: any) => ({ date: c.date, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) }));
  } catch { return []; }
}
async function fetchQuoteLite(base: string, symbol: string): Promise<QuoteLite> {
  try {
    const res = await fetch(`${base}/api/fmp/quote?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    const j = await res.json();
    const row = (Array.isArray(j) ? j[0] : j) || {};
    return { price: Number(row.price), avgVolume: Number(row.avgVolume || row.avgVolume10Day || row.averageVolume), marketCap: Number(row.marketCap), changesPercentage: Number(row.changesPercentage) };
  } catch { return {}; }
}
async function fetchFloatShares(base: string, symbol: string): Promise<number | null> {
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
  return null;
}
function toET(dateIso: string) { return new Date(new Date(dateIso).toLocaleString("en-US", { timeZone: "America/New_York" })); }
function isSameETDay(d: Date, ymd: string) { const mo = String(d.getMonth() + 1).padStart(2, "0"); const da = String(d.getDate()).padStart(2, "0"); return `${d.getFullYear()}-${mo}-${da}` === ymd; }
function yyyyMmDdETFromUTC(utc: Date) { const parts = toETParts(utc); return parts.ymd; }

function computeOpeningRange(candles: Candle[], ymd: string) {
  const win = candles.filter((c) => { const d = toET(c.date); return isSameETDay(d, ymd) && d.getHours() === 9 && d.getMinutes() >= 30 && d.getMinutes() <= 33; });
  if (!win.length) return null;
  const high = Math.max(...win.map((c) => c.high));
  const low = Math.min(...win.map((c) => c.low));
  return { high, low };
}
function computeVWAPUpTo(candles: Candle[], ymd: string, cutoffET: Date) {
  const session = candles.filter((c) => { const d = toET(c.date); const mins = d.getHours() * 60 + d.getMinutes(); const cut = cutoffET.getHours() * 60 + cutoffET.getMinutes(); return isSameETDay(d, ymd) && mins >= 9 * 60 + 30 && mins <= cut; });
  if (!session.length) return null;
  let pv = 0, vol = 0;
  for (const c of session) { const typical = (c.high + c.low + c.close) / 3; pv += typical * c.volume; vol += c.volume; }
  return vol > 0 ? pv / vol : null;
}
function computeRelVol5(candles: Candle[], ymd: string, cutoffET: Date, N = 5) {
  const day = candles.filter((c) => isSameETDay(toET(c.date), ymd) && toET(c.date).getTime() <= cutoffET.getTime());
  if (day.length < N + 1) return null;
  const last = day[day.length - 1];
  const prior = day.slice(-1 - N, -1);
  const avgPrior = prior.reduce((s, c) => s + c.volume, 0) / N;
  if (!avgPrior) return null;
  return last.volume / avgPrior;
}
function computeVWAPSlope(candles: Candle[], ymd: string, cutoffET: Date, backMinutes = 3) {
  const backCut = new Date(cutoffET.getTime() - backMinutes * 60_000);
  const v1 = computeVWAPUpTo(candles, ymd, cutoffET);
  const v0 = computeVWAPUpTo(candles, ymd, backCut);
  if (v1 == null || v0 == null) return null;
  return v1 - v0;
}
function last3Trend(candles: Candle[], ymd: string, cutoffET: Date) {
  const day = candles.filter((c) => isSameETDay(toET(c.date), ymd) && toET(c.date).getTime() <= cutoffET.getTime());
  const w = day.slice(-3);
  if (w.length < 3) return null;
  const higherCloses = w[2].close > w[1].close && w[1].close > w[0].close;
  const higherLows = w[2].low >= w[1].low && w[1].low >= w[0].low;
  return { higherCloses, higherLows };
}

/* Deep “why” for a trade */
async function buildWhyTradeDeep(base: string, symbol: string, entryUTC: Date): Promise<string | null> {
  const ymd = yyyyMmDdETFromUTC(entryUTC);
  const candles = await fetchCandles1m(base, symbol, 360);
  if (!candles.length) return null;

  const entryET = new Date(new Date(entryUTC).toLocaleString("en-US", { timeZone: "America/New_York" }));
  const upTo = candles.filter((c) => isSameETDay(toET(c.date), ymd) && toET(c.date).getTime() <= entryET.getTime());
  if (!upTo.length) return null;
  const last = upTo[upTo.length - 1];

  const quote = await fetchQuoteLite(base, symbol);
  const float = await fetchFloatShares(base, symbol).catch(() => null);

  const or = computeOpeningRange(candles, ymd);
  const vwap = computeVWAPUpTo(candles, ymd, entryET);
  const vwapSlope = computeVWAPSlope(candles, ymd, entryET, 3);
  const rvol5 = computeRelVol5(candles, ymd, entryET, 5);
  const trend = last3Trend(candles, ymd, entryET);

  const nearOrBreak = or ? (last.close > or.high ? "breaking OR high" : (last.close >= or.high * 0.995 ? "testing OR high" : "")) : "";

  let spreadNote = "";
  try { const tight = await spreadGuardOK(symbol, 0.005); spreadNote = tight ? "spread looked tight" : "spread was a bit wide"; }
  catch { spreadNote = "spread check unavailable"; }

  const stopAnchor =
    vwap != null && last.low >= vwap * 0.995 ? { kind: "VWAP hold", level: vwap } :
    or ? { kind: "OR low", level: or.low } : null;

  const dayHighSoFar = Math.max(...upTo.map((c) => c.high));
  const target = Math.max(dayHighSoFar, or?.high ?? -Infinity);

  const bits: string[] = [];
  if (vwap != null) {
    const dist = pct(last.close, vwap);
    const slopeStr = vwapSlope == null ? "" : vwapSlope > 0 ? "up-sloping" : vwapSlope < 0 ? "down-sloping" : "flat";
    bits.push(`price was ${dist != null ? `${(dist * 100).toFixed(2)}%` : ""} above VWAP (${slopeStr})`);
  }
  if (nearOrBreak) bits.push(nearOrBreak);
  if (trend?.higherCloses || trend?.higherLows) {
    const tbits: string[] = [];
    if (trend?.higherCloses) tbits.push("higher closes");
    if (trend?.higherLows) tbits.push("rising lows");
    bits.push(`intraday trend showed ${tbits.join(" & ")}`);
  }
  if (rvol5 != null) {
    const rStr = rvol5 >= 1.2 ? `${rvol5.toFixed(2)}× (elevated)` : rvol5 >= 0.9 ? `${rvol5.toFixed(2)}× (normal-ish)` : `${rvol5.toFixed(2)}× (light)`;
    bits.push(`5-min relative volume ${rStr}`);
  }

  const liq: string[] = [];
  const fnum = Number(float);
  if (Number.isFinite(fnum) && fnum > 0) {
    if (fnum < 20_000_000) liq.push("low float — can move fast");
    else if (fnum < 60_000_000) liq.push("moderate float");
  }
  if (Number.isFinite(Number(quote.avgVolume)) && quote.avgVolume! > 0) liq.push(`avg volume ~${Math.round(quote.avgVolume!).toLocaleString()}`);
  if (Number.isFinite(Number(quote.marketCap)) && quote.marketCap! > 0) {
    const mc = quote.marketCap!;
    liq.push(mc < 300e6 ? "small-cap" : mc < 2e9 ? "mid-cap" : "large-cap");
  }
  if (liq.length) bits.push(liq.join(", "));
  if (spreadNote) bits.push(spreadNote);

  const lines: string[] = [];
  lines.push(`Setup read: ${bits.length ? bits.join("; ") : "no strong signals captured at entry time"}`);

  if (stopAnchor && Number.isFinite(stopAnchor.level)) {
    const riskPS = Math.max(0, last.close - stopAnchor.level);
    const rr = Number.isFinite(target) && target > last.close && riskPS > 0 ? (target - last.close) / riskPS : null;
    lines.push(`Risk frame: stop ~${stopAnchor.kind} ($${stopAnchor.level.toFixed(2)}), risk/share ≈ $${riskPS.toFixed(2)}${rr != null ? `, R:R ≈ ${rr.toFixed(2)}×` : ""}.`);
  }

  if (rvol5 != null && rvol5 < 0.9) lines.push(`Note: volume was lighter than average at entry; we kept expectations modest and respected the stop.`);
  return lines.join("\n");
}

/* Live facts -> LLM answer */
async function buildLiveFactsForSymbol(base: string, symbol: string) {
  const nowUTC = new Date();
  const ymd = yyyyMmDdETFromUTC(nowUTC);
  const nowET = new Date(new Date(nowUTC).toLocaleString("en-US", { timeZone: "America/New_York" }));

  const [candles, quote, float] = await Promise.all([
    fetchCandles1m(base, symbol, 360),
    fetchQuoteLite(base, symbol),
    fetchFloatShares(base, symbol),
  ]);

  const day = candles.filter((c) => isSameETDay(toET(c.date), ymd));
  const last = day[day.length - 1];

  const or = computeOpeningRange(candles, ymd);
  const vwap = computeVWAPUpTo(candles, ymd, nowET);
  const rvol5 = computeRelVol5(candles, ymd, nowET, 5);
  const vwapSlope = computeVWAPSlope(candles, ymd, nowET, 3);
  const trend = last3Trend(candles, ymd, nowET);

  const aboveVWAP = vwap != null && last ? last.close >= vwap : null;
  const dayHigh = day.length ? Math.max(...day.map(c => c.high)) : null;
  const dayLow  = day.length ? Math.min(...day.map(c => c.low))  : null;

  return {
    symbol,
    ymd,
    price: last?.close ?? quote.price ?? null,
    lastBarTimeET: last ? toET(last.date).toISOString() : null,
    changePct: quote.changesPercentage ?? null,
    vwap,
    vwapSlope,
    openingRange: or,
    relVol5: rvol5,
    trend,
    aboveVWAP,
    dayHigh, dayLow,
    float,
    avgVolume: quote.avgVolume ?? null,
    marketCap: quote.marketCap ?? null,
  };
}

async function answerStockQuestionWithLLM(userQuestion: string, facts: any) {
  if (!openai) return null;
  const system = "You are a grounded trading copilot. Answer using ONLY the provided facts (JSON). If a detail isn't present, say you don't know yet. Be concise, neutral, and avoid advice. Include numeric levels like price/VWAP/OR when relevant. 1–4 short sentences max.";
  const user = `Question: ${userQuestion}\n\nFacts (JSON):\n${JSON.stringify(facts)}`;
  return await safeChat([{ role: "system", content: system }, { role: "user", content: user }]);
}

/* ───────────────── NEW: “why didn't we trade today?” explainer ───────────────── */
function humanizeNoTradeReasons(tick: any): string {
  if (!tick) return "I couldn't fetch the bot’s latest status.";
  const parts: string[] = [];

  // Market/weekday guard
  if (tick.skipped === "not_weekday") parts.push("Market was closed (not a weekday).");

  const dbg = tick.debug || {};
  const reasons: string[] = Array.isArray(dbg.reasons) ? dbg.reasons : [];
  const info = tick.info || {};
  const liq = info.liquidity || {};

  // High-level reasons
  if (reasons.includes("scan_no_ai_pick_yet")) parts.push("No AI pick was available during the scan window.");
  if (reasons.includes("scan_no_armed_signal_after_eval")) parts.push("Signals didn’t arm (no momentum/dip confirmation).");
  if (reasons.some((r) => r.startsWith("force_spread_guard_fail_"))) parts.push("Spread guard blocked entries in the force window.");

  // Detailed per-symbol evals if present
  const evals = dbg.scan_evals || {};
  const perTickers: string[] = [];
  for (const sym of Object.keys(evals)) {
    const ev = evals[sym] || {};
    const why: string[] = [];
    if (ev?.debug?.spread && ev?.debug?.spread.spreadOK === false) {
      const lim = ev.debug.spread.limitPct != null ? `${(ev.debug.spread.limitPct * 100).toFixed(2)}%` : "limit";
      why.push(`spread too wide (limit ${lim})`);
    }
    if (ev?.debug?.liquidity && ev?.debug?.liquidity.ok === false) {
      const det = ev.debug.liquidity;
      const need = det?.minSharesReq != null ? det.minSharesReq.toLocaleString() : "n/a";
      const dvol = det?.dollarVol != null ? `$${Math.round(det.dollarVol).toLocaleString()}` : "n/a";
      why.push(`liquidity short (needed ≥ ${need} sh/min & $${(tick?.info?.liquidity?.minDollarVol ?? 0).toLocaleString()} $, saw ${dvol})`);
    }
    if (ev?.meta?.reason === "price_band") why.push("price outside allowed band");
    if (!ev?.armed && !ev?.armedDip && !ev?.armedMomentum) why.push("no armed signals");

    if (why.length) perTickers.push(`${sym}: ${why.join("; ")}`);
  }

  // Compose message
  if (perTickers.length) {
    parts.push(`Per-ticker checks — ${perTickers.join(" | ")}`);
  }

  // Add thresholds so the user sees the guardrails
  const liqLine = (liq?.minSharesAbs || liq?.floatPctPerMin || liq?.minDollarVol)
    ? `Liquidity thresholds: min shares ${liq.minSharesAbs?.toLocaleString?.() ?? "?"}, float/min ${(liq.floatPctPerMin*100)?.toFixed?.(3) ?? "?"}%, dollar vol $${liq.minDollarVol?.toLocaleString?.() ?? "?"} (per 1-min bar).`
    : "";
  if (liqLine) parts.push(liqLine);

  // Special windows’ flags
  if (info?.scan_0930_0944 === false && info?.force_0945_0946 === false) {
    parts.push("We were outside the scan/force windows.");
  }

  return parts.length ? parts.join(" ") : "No trade executed; bot did not meet entry conditions.";
}

async function explainNoTradeToday(base: string) {
  const tick = await fetchBotTick(base);
  const draft = humanizeNoTradeReasons(tick);
  // Try to keep it crisp with the LLM polish if available
  return await maybePolishReply(draft, { tick });
}
/* ───────────────── Small formatters ───────────────── */
function summarizeTrades(trades: DbTrade[]) {
  if (trades.length === 0) return "No trades in that range.";
  const byDay = new Map<string, DbTrade[]>();
  for (const t of trades) {
    const ymd = toETParts(new Date(t.at)).ymd;
    const arr = byDay.get(ymd) || [];
    arr.push(t);
    byDay.set(ymd, arr);
  }
  const lines: string[] = [];
  for (const [ymd, dayTrades] of Array.from(byDay.entries()).sort()) {
    const tickers = Array.from(new Set(dayTrades.map(t => t.ticker)));
    lines.push(`${ymd}: ${tickers.join(", ")}`);
  }
  return lines.join(" • ");
}
function priceOf(tr: DbTrade) {
  const p = tr.filledPrice != null ? asNumber(tr.filledPrice) : asNumber(tr.price);
  return Number.isFinite(p) ? p : asNumber(tr.price);
}

/* ───────────────── POST ───────────────── */
export async function POST(req: Request) {
  try {
    const { message } = await req.json();
    const msg: string = String(message || "");
    const nowUTC = new Date();

    const intent = parseIntent(msg);
    const { startUTC, endUTC, label } = parseDateRangeETFromMessage(msg, nowUTC);

    const tradesInRange = await prisma.trade.findMany({
      where: { at: { gte: startUTC, lte: endUTC } },
      orderBy: { id: "asc" },
    }) as unknown as DbTrade[];
    const openPos = await prisma.position.findFirst({
      where: { open: true },
      orderBy: { id: "desc" },
    }) as unknown as DbPos | null;

    if (intent === "help") {
      const reply =
        "I’ve got you. Try:\n" +
        "- What did we trade today / yesterday / last 5 days?\n" +
        "- What’s my P&L today / this week / this month?\n" +
        "- Are we holding anything?\n" +
        "- Why did we trade ABCD?\n" +
        "- Why didn’t we trade today?\n" + // ← NEW example in help
        "- What price did we sell/exit ABCD?\n" +
        "- What price did we buy/enter ABCD?\n" +
        "- Ask about a ticker with $ (e.g., “Is $ABCD above VWAP?”)";
      return NextResponse.json({ reply });
    }

    if (intent === "why_no_trade") { // ← NEW: explicit intent
      const base = getBaseUrl(req);
      const reply = await explainNoTradeToday(base);
      return NextResponse.json({ reply });
    }

    if (intent === "what_traded") {
      const summary = summarizeTrades(tradesInRange);
      const draft = summary === "No trades in that range."
        ? tone.fun(`no trades ${label}.`)
        : tone.fun(`trades ${label}: ${summary}`);
      return NextResponse.json({ reply: await maybePolishReply(draft) });
    }

    if (intent === "pnl") {
      const realized = realizedFIFO(tradesInRange);
      const draft = !tradesInRange.length
        ? tone.fun(`no trades ${label}, so realized P&L is $0.00.`)
        : tone.fun(`realized P&L ${label}: ${money(realized)}.`);
      return NextResponse.json({ reply: await maybePolishReply(draft, { realized, label }) });
    }

    if (intent === "in_position") {
      const draft = openPos?.open ? tone.holding(openPos) : tone.flat();
      return NextResponse.json({ reply: await maybePolishReply(tone.fun(draft)) });
    }

    /* SELL PRICE */
    if (intent === "sell_price") {
      const ticker = chooseTickerFromContext(msg, tradesInRange, { requireTraded: true, allowBare: true });
      if (!ticker) {
        const tickers = Array.from(new Set(tradesInRange.map(t => t.ticker.toUpperCase())));
        if (tickers.length > 1) return NextResponse.json({ reply: tone.fun(`got a few names ${label}: ${tickers.join(", ")}. Which exits do you want?`) });
        return NextResponse.json({ reply: tone.fun(`no trades ${label}, so no exits to report.`) });
      }
      const rowsForTicker = tradesInRange.filter(t => t.ticker.toUpperCase() === ticker);
      const sells = rowsForTicker.filter(t => String(t.side).toUpperCase() === "SELL");
      const buys = rowsForTicker.filter(t => String(t.side).toUpperCase() === "BUY");

      if (!rowsForTicker.length) return NextResponse.json({ reply: tone.fun(`didn’t see ${ticker} ${label}.`) });
      if (!sells.length) {
        if (openPos?.open && openPos.ticker.toUpperCase() === ticker) return NextResponse.json({ reply: tone.fun(`haven’t sold ${ticker} yet — still holding.`) });
        return NextResponse.json({ reply: tone.fun(`no sell fills for ${ticker} ${label}. Try “yesterday” or “last 5 days”.`) });
      }

      const totalSold = sells.reduce((s, r) => s + r.shares, 0);
      const wAvgExit = sells.reduce((s, r) => s + priceOf(r) * r.shares, 0) / Math.max(1, totalSold);

      const lines: string[] = [];
      lines.push(tone.fun(`sold ${ticker} ${label} in ${sells.length} fill${sells.length > 1 ? "s" : ""} (avg exit ~$${wAvgExit.toFixed(2)})`));
      for (const s of sells) {
        const when = toETParts(new Date(s.filledAt || s.at));
        lines.push(`• ${when.ymd} ${when.hms} ET — ${s.shares} @ $${priceOf(s).toFixed(2)}`);
      }
      if (buys.length) {
        const totBought = buys.reduce((s, r) => s + r.shares, 0);
        const wAvgEntry = buys.reduce((s, r) => s + priceOf(r) * r.shares, 0) / Math.max(1, totBought);
        lines.push(`Entry avg ~$${wAvgEntry.toFixed(2)}; Exit avg ~$${wAvgExit.toFixed(2)}.`);
      }
      const symRealized = realizedForTicker(rowsForTicker, ticker);
      lines.push(`Realized on ${ticker} ${label}: ${money(symRealized)}.`);
      return NextResponse.json({ reply: lines.join("\n") });
    }

    /* ENTRY PRICE */
    if (intent === "entry_price") {
      const ticker =
        chooseTickerFromContext(msg, tradesInRange, { requireTraded: true, allowBare: true }) ||
        (openPos?.open ? openPos.ticker.toUpperCase() : null);

      if (!ticker) {
        const tickers = Array.from(new Set(tradesInRange.map(t => t.ticker.toUpperCase())));
        if (tickers.length > 1) return NextResponse.json({ reply: tone.fun(`I’ve got multiple names ${label}: ${tickers.join(", ")}. Which entry do you want?`) });
        return NextResponse.json({ reply: tone.fun(`no trades ${label} yet — nothing to enter.`) });
      }

      if (openPos?.open && openPos.ticker.toUpperCase() === ticker) {
        const et = toETParts(new Date(openPos.entryAt));
        const price = asNumber(openPos.entryPrice).toFixed(2);
        return NextResponse.json({ reply: tone.fun(`current ${ticker} entry: $${price} (${et.ymd} ${et.hms} ET).`) });
      }

      const rowsForTicker = tradesInRange.filter(t => t.ticker.toUpperCase() === ticker);
      const buys = rowsForTicker.filter(t => String(t.side).toUpperCase() === "BUY");

      if (!rowsForTicker.length || !buys.length) {
        return NextResponse.json({ reply: tone.fun(`no buy fills for ${ticker} ${label}. If it was earlier, try “yesterday” or “last 5 days”.`) });
      }

      const totBought = buys.reduce((s, r) => s + r.shares, 0);
      const wAvgEntry = buys.reduce((s, r) => s + priceOf(r) * r.shares, 0) / Math.max(1, totBought);

      const lines: string[] = [];
      lines.push(tone.fun(`bought ${ticker} ${label} in ${buys.length} fill${buys.length > 1 ? "s" : ""} (avg entry ~$${wAvgEntry.toFixed(2)})`));
      for (const b of buys) {
        const when = toETParts(new Date(b.filledAt || b.at));
        lines.push(`• ${when.ymd} ${when.hms} ET — ${b.shares} @ $${priceOf(b).toFixed(2)}`);
      }
      return NextResponse.json({ reply: lines.join("\n") });
    }

    /* WHY TRADE */
    if (intent === "why_trade") {
      const tradedTickers = Array.from(new Set(tradesInRange.map(t => t.ticker.toUpperCase())));
      let ticker = chooseTickerFromContext(msg, tradesInRange, { requireTraded: true, allowBare: true });
      if (!ticker) {
        if (tradedTickers.length === 1) ticker = tradedTickers[0];
        else if (tradedTickers.length > 1) return NextResponse.json({ reply: tone.fun(`I’ve got a few names ${label}: ${tradedTickers.join(", ")}. Which one do you want the why for?`) });
        else return NextResponse.json({ reply: tone.fun(`no trades ${label}, so there’s nothing to explain.`) });
      }

      const relevant = tradesInRange.filter(t => t.ticker.toUpperCase() === ticker);
      if (!relevant.length) return NextResponse.json({ reply: tone.fun(`didn’t see ${ticker} ${label}.`) });

      const entryTrade = relevant.find(t => String(t.side).toUpperCase() === "BUY") || relevant[0];
      const whenET = toETParts(new Date(entryTrade.at));
      const side = String(entryTrade.side).toUpperCase();
      const priceStr = asNumber(entryTrade.price).toFixed(2);

      const recRows = await prisma.recommendation.findMany({
        where: { ticker, at: { gte: new Date(startUTC.getTime() - 12 * 60 * 60 * 1000), lte: new Date(endUTC.getTime() + 12 * 60 * 60 * 1000) } },
        orderBy: { at: "desc" }, take: 1,
      }) as unknown as DbReco[];
      const recExp = (recRows?.[0]?.explanation || "").trim() || null;

      const base = getBaseUrl(req);
      const deep = await buildWhyTradeDeep(base, ticker, new Date(entryTrade.at));

      const header = `We ${side === "BUY" ? "entered" : "executed a " + side} ${ticker} ${label} around $${priceStr} (${whenET.ymd} ${whenET.hms} ET).`;
      const reasonBlock = recExp ? `Reason (from the AI pick): ${recExp}` : (deep ?? "I didn’t capture a thesis at the time, but I’ll log one on future entries.");
      const draft = `${header}\n${reasonBlock}`;
      return NextResponse.json({ reply: await maybePolishReply(draft) });
    }

    /* WHY PICK (non-traded allowed) */
    if (intent === "why_pick") {
      const ticker = chooseTickerFromContext(msg, tradesInRange, { requireTraded: false, allowBare: true });
      if (!ticker) return NextResponse.json({ reply: tone.fun("tell me the ticker (e.g., “Why did the AI pick ABCD today?”) and I’ll pull it up.") });
      const rec = await prisma.recommendation.findMany({
        where: { ticker, at: { gte: new Date(startUTC.getTime() - 12 * 60 * 60 * 1000), lte: new Date(endUTC.getTime() + 12 * 60 * 60 * 1000) } },
        orderBy: { at: "desc" }, take: 1,
      }) as unknown as DbReco[];
      const row = rec?.[0];
      if (row) {
        const whenET = toETParts(new Date(row.at));
        const price = asNumber(row.price).toFixed(2);
        const exp = (row.explanation || "").trim();
        const draft = exp
          ? tone.fun(`AI picked ${ticker} ${label} around $${price} (${whenET.ymd} ${whenET.hms} ET). Reason: ${exp}`)
          : tone.fun(`AI picked ${ticker} ${label} around $${price} (${whenET.ymd} ${whenET.hms} ET), but no explanation was saved.`);
        return NextResponse.json({ reply: await maybePolishReply(draft) });
      }
      return NextResponse.json({ reply: tone.fun(`couldn’t find a saved recommendation for ${ticker} ${label}. Make sure /api/recommendation stores the explanation.`) });
    }

    /* Free-form stock Q&A: require $TICKER to avoid false positives */
    const base = getBaseUrl(req);
    const freeTicker = chooseTickerFromContext(msg, tradesInRange, { requireTraded: false, allowBare: false });
    if (freeTicker) {
      const facts = await buildLiveFactsForSymbol(base, freeTicker);
      if (!facts.price && !facts.vwap && !facts.openingRange && !facts.relVol5) {
        return NextResponse.json({ reply: tone.fun(`I couldn’t fetch fresh data for ${freeTicker} right now.`) });
      }
      const llm = await answerStockQuestionWithLLM(msg, facts);
      if (llm) return NextResponse.json({ reply: llm });
      const parts: string[] = [];
      parts.push(`${facts.symbol}: ${facts.price != null ? `$${facts.price.toFixed?.(2) ?? facts.price}` : "price n/a"}.`);
      if (facts.vwap != null) parts.push(`VWAP ${facts.vwap.toFixed(2)}${facts.aboveVWAP != null ? facts.aboveVWAP ? " (above)" : " (below)" : ""}.`);
      if (facts.openingRange?.high != null) parts.push(`ORH ${facts.openingRange.high.toFixed(2)}.`);
      if (facts.relVol5 != null) parts.push(`RelVol(5m) ${facts.relVol5.toFixed(2)}×.`);
      if (facts.dayHigh != null && facts.dayLow != null) parts.push(`Day ${facts.dayLow.toFixed(2)}–${facts.dayHigh.toFixed(2)}.`);
      if (facts.vwapSlope != null) parts.push(`VWAP slope ${facts.vwapSlope > 0 ? "up" : facts.vwapSlope < 0 ? "down" : "flat"}.`);
      return NextResponse.json({ reply: parts.join(" ") });
    }

    // Default status
    const realized = realizedFIFO(tradesInRange);
    const traded = summarizeTrades(tradesInRange);
    const pieces: string[] = [];
    pieces.push(openPos?.open ? tone.holding(openPos) : tone.flat());
    if (traded === "No trades in that range.") {
      // NEW: if user didn't explicitly ask but there were no trades today, volunteer a one-liner reason
      const base = getBaseUrl(req);
      const why = await explainNoTradeToday(base).catch(() => null);
      pieces.push(`No trades ${label}.`);
      if (why) pieces.push(why);
    } else {
      pieces.push(`Trades ${label}: ${traded}.`);
    }
    if (tradesInRange.length) pieces.push(`Realized P&L ${label}: ${money(realized)}.`);
    const draft = tone.fun(pieces.join(" "));
    return NextResponse.json({ reply: await maybePolishReply(draft, { openPos, traded, realized, label }) });

  } catch (e: any) {
    return NextResponse.json({ reply: `Sorry — I couldn’t process that. ${e?.message || "Unknown error."}` }, { status: 200 });
  }
}

/* ───────────────── GET debug ───────────────── */
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("debug") !== "1") {
    return NextResponse.json({ reply: "Send a POST with { message }." });
  }
  const trades = await prisma.trade.findMany({ orderBy: { id: "desc" }, take: 20 }) as unknown as DbTrade[];
  const rows = trades.map((t) => {
    const et = toETParts(new Date(t.at));
    return {
      id: t.id,
      ticker: t.ticker,
      side: t.side,
      price: asNumber(t.price),
      shares: t.shares,
      at_utc: new Date(t.at).toISOString(),
      at_et: `${et.ymd} ${et.hms}`,
      filledAt_utc: t.filledAt ? new Date(t.filledAt).toISOString() : null,
      filledPrice: t.filledPrice != null ? asNumber(t.filledPrice) : null,
    };
  });
  return NextResponse.json({ last: rows });
}
