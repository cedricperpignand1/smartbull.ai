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
const CHAT_MAX_TOKENS = Number(process.env.CHAT_MAX_TOKENS ?? 600);

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

// Keep for short answers (P&L, status). We’ll SKIP this for long “why” narratives.
async function maybePolishReply(draft: string, facts?: any, opts: { maxLen?: number } = {}) {
  if (!openai) return draft;
  const maxLen = opts.maxLen ?? 900;
  if (draft.length > maxLen || draft.split("\n").length > 20) return draft;
  const system =
    "You are a concise trading assistant. Rewrite the user's draft answer into clearer, smoother English without adding new facts. " +
    "Keep numbers and tickers exact. Prefer short sentences. No advice or hype. Preserve structure if present.";
  const user = (facts ? `Facts (JSON):\n${JSON.stringify(facts)}\n\n` : "") + `Draft answer:\n${draft}\n\nReturn plaintext only.`;
  const out = await safeChat([{ role: "system", content: system }, { role: "user", content: user }]);
  return out || draft;
}

/* ───────────────── Time helpers (ET) ───────────────── */
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
/* ───────────────── Week config ───────────────── */
// Choose how to interpret "week":
//  - "trading": Monday→Friday ET (common for P&L)
//  - "calendar": Monday→Sunday ET
const WEEK_MODE: "trading" | "calendar" = "trading";

/* ───────────────── Week helpers (ET) ───────────────── */
function etOffsetMin(utc: Date) {
  return isDST_US_Eastern(utc) ? -240 : -300; // minutes to add to UTC to get ET clock
}
function etDate(utc: Date) {
  return new Date(utc.getTime() + etOffsetMin(utc) * 60_000);
}
function etDayOfWeek(utc: Date) {
  // 0=Sun..6=Sat in ET
  return etDate(utc).getUTCDay();
}

/** Monday 00:00:00 ET for the week containing utcInstant. */
function startOfETWeekUTC(utcInstant: Date): Date {
  const startDay = startOfETDayUTC(utcInstant);
  const dow = etDayOfWeek(utcInstant); // 0..6
  const daysFromMonday = (dow + 6) % 7; // Sun->6, Mon->0, Tue->1, ...
  return new Date(startDay.getTime() - daysFromMonday * 24 * 60 * 60 * 1000);
}

/** End of week depending on mode. */
function endOfETWeekUTCFromStart(weekStartUTC: Date): Date {
  if (WEEK_MODE === "trading") {
    // Friday 23:59:59.999 ET
    const friStartUTC = new Date(weekStartUTC.getTime() + 4 * 24 * 60 * 60 * 1000);
    return endOfETDayUTC(friStartUTC);
  }
  // calendar: Sunday 23:59:59.999 ET
  return new Date(weekStartUTC.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
}

/**
 * For weekend-aware WTD:
 *  - If Sat/Sun and WEEK_MODE === 'trading', return the Mon→Fri that just ended.
 *  - Otherwise Mon→today (end of day).
 */
function weekToDateRange(nowUTC: Date) {
  const weekStart = startOfETWeekUTC(nowUTC);
  const dow = etDayOfWeek(nowUTC); // 0=Sun, 6=Sat

  if (WEEK_MODE === "trading") {
    if (dow === 6 || dow === 0) {
      // Sat/Sun → show the finished trading week (Mon→Fri)
      const end = endOfETWeekUTCFromStart(weekStart);
      return { startUTC: weekStart, endUTC: end, label: "this week (Mon–Fri)" };
    }
    // Mon–Fri → WTD is Mon→today
    return { startUTC: weekStart, endUTC: endOfETDayUTC(nowUTC), label: "week to date" };
  }

  // calendar mode: Mon→today (or Mon→Sun if Sunday)
  if (dow === 0) {
    return { startUTC: weekStart, endUTC: endOfETDayUTC(nowUTC), label: "this week" };
  }
  return { startUTC: weekStart, endUTC: endOfETDayUTC(nowUTC), label: "week to date" };
}

/* ───────────────── Parse ET date range from message ───────────────── */
function parseDateRangeETFromMessage(msg: string, nowUTC: Date): { startUTC: Date; endUTC: Date; label: string } {
  const lower = msg.toLowerCase();

  // explicit YYYY-MM-DD
  const on = lower.match(/\b(on\s+)?(\d{4})[-/](\d{2})[-/](\d{2})\b/);
  if (on) {
    const Y = Number(on[2]), M = Number(on[3]), D = Number(on[4]);
    const anchor = new Date(Date.UTC(Y, M - 1, D, 12));
    return { startUTC: startOfETDayUTC(anchor), endUTC: endOfETDayUTC(anchor), label: `${Y}-${String(M).padStart(2,"0")}-${String(D).padStart(2,"0")}` };
  }

  // between YYYY-MM-DD and YYYY-MM-DD
  const between = lower.match(/\bbetween\s+(\d{4})[-/](\d{2})[-/](\d{2})\s+(and|to)\s+(\d{4})[-/](\d{2})[-/](\d{2})\b/);
  if (between) {
    const Y1 = Number(between[1]), M1 = Number(between[2]), D1 = Number(between[3]);
    const Y2 = Number(between[5]), M2 = Number(between[6]), D2 = Number(between[7]);
    const a = new Date(Date.UTC(Y1, M1 - 1, D1, 12));
    const b = new Date(Date.UTC(Y2, M2 - 1, D2, 12));
    return { startUTC: startOfETDayUTC(a), endUTC: endOfETDayUTC(b), label: `${Y1}-${String(M1).padStart(2,"0")}-${String(D1).padStart(2,"0")} → ${Y2}-${String(M2).padStart(2,"0")}-${String(D2).padStart(2,"0")}` };
  }

  // Week-specific phrases first (before rolling windows)
  if (/\b(this week|for the week|week to date|wtd)\b/.test(lower)) {
    return weekToDateRange(nowUTC);
  }

  if (/\blast week\b/.test(lower)) {
    // previous full week
    const thisWeekStart = startOfETWeekUTC(nowUTC);
    const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const lastWeekEnd = endOfETWeekUTCFromStart(lastWeekStart);
    const label = WEEK_MODE === "trading" ? "last week (Mon–Fri)" : "last week";
    return { startUTC: lastWeekStart, endUTC: lastWeekEnd, label };
  }

  // month helpers unchanged
  if (/\bthis month\b/.test(lower)) {
    const parts = toETParts(nowUTC);
    const [Y, M] = parts.ymd.split("-").map(Number);
    const start = startOfETDayUTC(new Date(Date.UTC(Y, M - 1, 1, 12)));
    const firstNext = new Date(Date.UTC(Y, M, 1, 12));
    const lastDay = new Date(firstNext.getTime() - 24 * 60 * 60 * 1000);
    return { startUTC: start, endUTC: endOfETDayUTC(lastDay), label: "this month" };
  }

  // yesterday
  if (/\byesterday\b/.test(lower)) {
    const todayStart = startOfETDayUTC(nowUTC);
    return { startUTC: new Date(todayStart.getTime() - 24 * 60 * 60 * 1000), endUTC: new Date(todayStart.getTime() - 1), label: "yesterday" };
  }

  // Rolling windows: last N days/weeks
  const lastX = lower.match(/\blast\s+(\d{1,2})\s*(day|days|week|weeks)\b/);
  if (lastX) {
    const n = Number(lastX[1]);
    const isWeek = lastX[2].startsWith("week");
    if (isWeek && WEEK_MODE === "trading") {
      // N trading weeks back-to-back (Mon→Fri, then previous Mon→Fri, etc.)
      const thisStart = startOfETWeekUTC(nowUTC);
      const end = endOfETWeekUTCFromStart(thisStart);
      const start = new Date(thisStart.getTime() - n * 7 * 24 * 60 * 60 * 1000);
      return { startUTC: start, endUTC: end, label: `last ${n} trading week${n>1?"s":""}` };
    } else {
      // simple rolling days/weeks
      const days = isWeek ? n * 7 : n;
      const end = endOfETDayUTC(nowUTC);
      const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000 + 1);
      return { startUTC: start, endUTC: end, label: `last ${n} ${isWeek ? "week" : "day"}${n>1?"s":""}` };
    }
  }

  // Default: today
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
function pctStr(p: number | null | undefined, opts: { sign?: boolean } = {}) {
  if (p == null || !Number.isFinite(p)) return "n/a";
  const base = (p * 100).toFixed(2) + "%";
  return opts.sign && p > 0 ? "+" + base : base;
}
function money(n: number) {
  if (!Number.isFinite(n)) return "n/a";
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}
function priceOfTrade(t: DbTrade) {
  const p = t.filledPrice != null ? asNumber(t.filledPrice) : asNumber(t.price);
  return Number.isFinite(p) ? p : asNumber(t.price);
}

/** REALIZED total across all tickers using per-ticker FIFO queues. */
function realizedFIFO(tradesAsc: DbTrade[]): number {
  const lotsByTicker = new Map<string, Lot[]>();
  let realized = 0;
  for (const t of tradesAsc) {
    const sym = t.ticker.toUpperCase();
    const p = priceOfTrade(t);
    const side = String(t.side).toUpperCase();
    const lots = lotsByTicker.get(sym) || [];
    if (side === "BUY") {
      lots.push({ qty: t.shares, cost: p });
      lotsByTicker.set(sym, lots);
    } else if (side === "SELL") {
      let remain = t.shares;
      while (remain > 0 && lots.length) {
        const lot = lots[0];
        const take = Math.min(lot.qty, remain);
        realized += (p - lot.cost) * take;
        lot.qty -= take;
        remain -= take;
        if (lot.qty === 0) lots.shift();
      }
      lotsByTicker.set(sym, lots);
    }
  }
  return realized;
}
function realizedForTicker(tradesAsc: DbTrade[], ticker: string) {
  const rows = tradesAsc.filter(t => t.ticker.toUpperCase() === ticker.toUpperCase());
  return realizedFIFO(rows);
}

/* ── carry-in lots from trades before the start of the range ── */
function buildSeedLotsBefore(priorTradesAsc: DbTrade[]): Map<string, Lot[]> {
  const lotsByTicker = new Map<string, Lot[]>();
  for (const t of priorTradesAsc) {
    const sym = t.ticker.toUpperCase();
    const p = priceOfTrade(t);
    const side = String(t.side).toUpperCase();
    const lots = lotsByTicker.get(sym) || [];
    if (side === "BUY") {
      lots.push({ qty: t.shares, cost: p });
    } else if (side === "SELL") {
      let remain = t.shares;
      while (remain > 0 && lots.length) {
        const lot = lots[0];
        const take = Math.min(lot.qty, remain);
        lot.qty -= take;               // consume prior lots
        remain -= take;
        if (lot.qty === 0) lots.shift();
      }
    }
    lotsByTicker.set(sym, lots);
  }
  return lotsByTicker;
}

/* ── realized per ET day, attributing P&L to SELL day; per-ticker FIFO with optional seeds ── */
function ymdETFromUTC(utc: Date): string {
  return toETParts(utc).ymd;
}
function realizedByDayFIFO(
  tradesAsc: DbTrade[],
  seedLotsByTicker?: Map<string, Lot[]>
): Map<string, number> {
  const byDay = new Map<string, number>();
  const lotsByTicker = new Map<string, Lot[]>();

  // copy seeds
  if (seedLotsByTicker) {
    for (const [sym, lots] of seedLotsByTicker.entries()) {
      lotsByTicker.set(sym, lots.map(l => ({ qty: l.qty, cost: l.cost })));
    }
  }

  for (const t of tradesAsc) {
    const sym = t.ticker.toUpperCase();
    const p = priceOfTrade(t);
    const side = String(t.side).toUpperCase();
    const lots = lotsByTicker.get(sym) || [];

    if (side === "BUY") {
      lots.push({ qty: t.shares, cost: p });
      lotsByTicker.set(sym, lots);
      continue;
    }

    if (side === "SELL") {
      let remain = t.shares;
      let dayPnl = 0;
      while (remain > 0 && lots.length) {
        const lot = lots[0];
        const take = Math.min(lot.qty, remain);
        dayPnl += (p - lot.cost) * take;
        lot.qty -= take;
        remain -= take;
        if (lot.qty === 0) lots.shift();
      }
      lotsByTicker.set(sym, lots);

      const when = new Date(t.filledAt || t.at);
      const ymd = ymdETFromUTC(when);
      byDay.set(ymd, (byDay.get(ymd) || 0) + dayPnl);
    }
  }
  return byDay;
}

/** Pretty money with +/- sign (no extra tone). */
function moneyFlat(n: number) {
  if (!Number.isFinite(n)) return "n/a";
  return (n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`);
}

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
  | "why_no_trade"
  | "help";

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

  if (isWhyNoTradeIntent(q)) return "why_no_trade";

  if (/(why).*(trade|traded|buy|bought|sell|sold|enter|entry|took|take|long|short)/.test(m)) return "why_trade";

  if (/(what|which).*(trade|trades|traded|tickers?)/.test(m)) return "what_traded";
  if (isPnlIntent(m)) return "pnl";
  if (/(are|am|you).*(in|holding).*(position)|open position/.test(m)) return "in_position";
  if (/(why).*(ai|bot).*(pick|choose|chose|selected?)/.test(m)) return "why_pick";
  if (/help|what can you do|commands?/.test(m)) return "help";
  return "status";
}

/* ───────────────── Ticker extraction ───────────────── */
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

function chooseTickerFromContext(
  msg: string,
  trades: DbTrade[],
  opts: { requireTraded?: boolean; allowBare?: boolean } = { requireTraded: true, allowBare: true }
): string | null {
  const traded = Array.from(new Set(trades.map(r => r.ticker.toUpperCase())));
  const tradedSet = new Set(traded);
  const { dollar, bare } = extractCandidates(msg);

  for (const t of dollar) {
    if (!opts.requireTraded) return t;
    if (tradedSet.has(t)) return t;
  }
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
type ProfileLite = { companyName?: string; country?: string; sector?: string; industry?: string };

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
async function fetchProfile(base: string, symbol: string): Promise<ProfileLite> {
  try {
    const r = await fetch(`${base}/api/fmp/profile?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    if (!r.ok) return {};
    const j = await r.json();
    const row = (Array.isArray(j) ? j[0] : (Array.isArray(j?.profile) ? j.profile[0] : j)) || {};
    return {
      companyName: String(row.companyName || row.company || row.name || ""),
      country: String(row.country || ""),
      sector: String(row.sector || ""),
      industry: String(row.industry || row.subIndustry || ""),
    };
  } catch { return {}; }
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

/* ───────────────── Rankings, tags, and paragraph WHY PICK ───────────────── */
function classifyFloatTag(floatVal?: number | null) {
  if (!Number.isFinite(Number(floatVal))) return null;
  const f = Number(floatVal);
  if (f < 20_000_000) return "low float";
  if (f < 60_000_000) return "moderate float";
  return "higher float";
}
function hypeTags(sector?: string, industry?: string) {
  const s = (sector || "").toLowerCase();
  const i = (industry || "").toLowerCase();
  const tags: string[] = [];
  if (s.includes("technology") || i.includes("semiconductor") || i.includes("ai")) tags.push("AI/semiconductors theme");
  if (i.includes("biotechnology") || i.includes("biotech")) tags.push("biotech momentum");
  if (i.includes("crypto") || i.includes("blockchain")) tags.push("crypto-related interest");
  if (i.includes("automobile") || i.includes("auto") || i.includes("ev")) tags.push("EV theme");
  if (i.includes("solar") || i.includes("renewable")) tags.push("clean energy buzz");
  return tags;
}
function extractTopCandidatesFromTick(tick: any): { symbol: string; score?: number | null }[] {
  const out: { symbol: string; score?: number | null }[] = [];
  const dbg = tick?.debug || {};
  const ranked = Array.isArray(dbg.rankings) ? dbg.rankings : Array.isArray(dbg.candidates) ? dbg.candidates : [];
  for (const item of ranked) {
    if (!item) continue;
    const sym = String(item.symbol || item.ticker || "").toUpperCase();
    if (!sym) continue;
    const score = Number.isFinite(Number(item.score)) ? Number(item.score) : null;
    out.push({ symbol: sym, score });
  }
  if (!out.length && dbg.scan_evals && typeof dbg.scan_evals === "object") {
    for (const sym of Object.keys(dbg.scan_evals)) out.push({ symbol: sym.toUpperCase(), score: null });
  }
  out.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  return out.slice(0, 2);
}

async function buildWhyPickNarrative(base: string, symbol: string) {
  const tick = await fetchBotTick(base);
  const evals = tick?.debug?.scan_evals || {};
  const ev = evals?.[symbol] || {};
  const spreadOK = ev?.debug?.spread?.spreadOK;
  const liqOK = ev?.debug?.liquidity?.ok;
  const dvol = ev?.debug?.liquidity?.dollarVol;
  const minDollarVol = tick?.info?.liquidity?.minDollarVol;

  const [quote, float, profile] = await Promise.all([
    fetchQuoteLite(base, symbol),
    fetchFloatShares(base, symbol),
    fetchProfile(base, symbol),
  ]);
  const floatTag = classifyFloatTag(float);
  const hype = hypeTags(profile.sector, profile.industry);
  const isUS = (profile.country || "").toLowerCase().includes("united states");

  const startUTC = startOfETDayUTC(new Date());
  const endUTC = endOfETDayUTC(new Date());
  const rec = await prisma.recommendation.findFirst({
    where: { ticker: symbol, at: { gte: startUTC, lte: endUTC } },
    orderBy: { at: "desc" },
  }) as any;
  const savedReason = (rec?.explanation || "").trim() || null;

  const top = extractTopCandidatesFromTick(tick);
  const youIdx = top.findIndex((t: any) => t.symbol === symbol.toUpperCase());
  const rival = top.find((t: any, idx: number) => idx !== youIdx);

  let rivalEv: any = null, rivalFloat: number | null = null, rivalProfile: ProfileLite = {};
  if (rival?.symbol) {
    rivalEv = evals?.[rival.symbol] || {};
    rivalFloat = await fetchFloatShares(base, rival.symbol);
    rivalProfile = await fetchProfile(base, rival.symbol);
  }

  const lines: string[] = [];
  const name = profile.companyName ? `${profile.companyName} (${symbol})` : symbol;
  const scoreStr = Number.isFinite(Number(ev?.score)) ? ` with the highest internal score (${Number(ev.score).toFixed(2)})` : "";

  lines.push(
    `We ranked ${name}${scoreStr} because it matched more of our preferred conditions at the time: ` +
    `${floatTag ? `${floatTag}` : "adequate float"}, ` +
    `${isUS ? "U.S.-listed," : (profile.country ? `${profile.country}-listed,` : "")} ` +
    `${hype.length ? `${hype.join(", ")}, ` : ""}` +
    `${spreadOK === false ? "but the spread was wider than our limit; " : spreadOK === true ? "tight bid–ask spread; " : ""}` +
    `${liqOK === false ? "intraday liquidity was below our threshold; " : liqOK === true ? "liquidity met our minimums; " : ""}` +
    `${Number.isFinite(dvol) ? `dollar volume around $${Math.round(dvol).toLocaleString()}; ` : ""}` +
    `${Number.isFinite(minDollarVol) ? `we require roughly $${Math.round(minDollarVol).toLocaleString()} per minute.` : ""}`
  );

  if (savedReason) lines.push(` The picker’s stored note for ${symbol} was: “${savedReason}”.`);

  if (rival?.symbol) {
    const rivalName = rivalProfile.companyName ? `${rivalProfile.companyName} (${rival.symbol})` : rival.symbol;
    const youVsRival: string[] = [];
    if (Number.isFinite(Number(ev?.score)) && Number.isFinite(Number(rival?.score))) {
      youVsRival.push(`its score (${Number(ev.score).toFixed(2)}) edged out ${rival.symbol} (${Number(rival.score).toFixed(2)})`);
    }
    if (spreadOK === true && rivalEv?.debug?.spread?.spreadOK === false) youVsRival.push("our spread check passed while the runner-up failed");
    if (liqOK === true && rivalEv?.debug?.liquidity?.ok === false) youVsRival.push("it met the intraday liquidity guard while the runner-up did not");
    if (float != null && rivalFloat != null) {
      const fA = classifyFloatTag(float), fB = classifyFloatTag(rivalFloat);
      if (fA === "low float" && fB !== "low float") youVsRival.push("its lower float can fuel faster moves");
      if (fA !== "low float" && fB === "low float") youVsRival.push("we preferred the steadier float profile versus the runner-up");
    }
    const hypeA = hypeTags(profile.sector, profile.industry).join("/");
    const hypeB = hypeTags(rivalProfile.sector, rivalProfile.industry).join("/");
    if (hypeA && !hypeB) youVsRival.push("it aligns with a current market-hype theme");
    if (youVsRival.length) lines.push(` We preferred it over ${rivalName} because ${youVsRival.join(", ")}.`);
    else lines.push(` It was slightly preferred over ${rivalName} given our checks at that moment.`);
  }

  lines.push(` In short, the picker liked ${symbol} because it fit our playbook—structure, liquidity, and market theme—better than the other candidate at that moment.`);
  return lines.join("");
}

/* ───────────────── WHY TRADE: detailed narrative builder (paragraph or headings) ───────────────── */
function renderWhyTradeReport(params: {
  symbol: string;
  entryPrice: number;
  entryET: string;
  orHigh?: number | null;
  orLow?: number | null;
  lastClose?: number | null;
  vwap?: number | null;
  vwapSlope?: number | null;
  relVol5?: number | null;
  trend?: { higherCloses?: boolean; higherLows?: boolean } | null;
  float?: number | null;
  avgVolume?: number | null;
  marketCap?: number | null;
  spreadNote?: string;
  stopAnchor?: { kind: string; level: number } | null;
  target?: number | null;
  recExplanation?: string | null;
}) {
  const {
    symbol, entryPrice, entryET,
    orHigh, orLow,
    lastClose,
    vwap, vwapSlope, relVol5, trend,
    float, avgVolume, marketCap,
    spreadNote,
    stopAnchor, target,
    recExplanation
  } = params;

  const bits: string[] = [];
  bits.push(`We entered ${symbol} around $${entryPrice.toFixed(2)} at ${entryET.replace("T", " ").replace(".000Z","")} ET.`);

  if (vwap != null && lastClose != null) {
    const dist = pct(lastClose, vwap);
    const slopeStr = vwapSlope == null ? "flat" : vwapSlope > 0 ? "rising" : vwapSlope < 0 ? "falling" : "flat";
    bits.push(`At entry, price was ${pctStr(dist, { sign: true })} versus VWAP while VWAP was ${slopeStr}.`);
  }
  if (typeof orHigh === "number" && lastClose != null) {
    if (lastClose > orHigh) bits.push(`Price had just broken above the opening-range high near $${orHigh.toFixed(2)}.`);
    else if (lastClose >= orHigh * 0.995) bits.push(`Price was testing the opening-range high near $${orHigh.toFixed(2)}.`);
  }
  if (trend?.higherCloses || trend?.higherLows) {
    const t: string[] = [];
    if (trend.higherCloses) t.push("higher closes");
    if (trend.higherLows) t.push("rising lows");
    if (t.length) bits.push(`The last few minutes showed ${t.join(" and ")} which supported momentum.`);
  }
  if (relVol5 != null) {
    const rv = relVol5.toFixed(2);
    bits.push(`Short-window relative volume was about ${rv}× versus recent bars.`);
  }
  if (spreadNote) bits.push(`The ${spreadNote}.`);

  const liq: string[] = [];
  if (Number.isFinite(float as number)) {
    const f = Number(float);
    if (f < 20_000_000) liq.push("low float that can move quickly");
    else if (f < 60_000_000) liq.push("moderate float");
    else liq.push("higher float");
  }
  if (Number.isFinite(avgVolume as number) && (avgVolume as number)! > 0) liq.push(`average daily volume near ${Math.round((avgVolume as number)!).toLocaleString()} shares`);
  if (Number.isFinite(marketCap as number) && (marketCap as number)! > 0) {
    const mc = Number(marketCap);
    liq.push(mc < 300e6 ? "small-cap profile" : mc < 2e9 ? "mid-cap profile" : "large-cap profile");
  }
  if (liq.length) bits.push(`Liquidity and size looked reasonable (${liq.join(", ")}).`);

  if (stopAnchor && Number.isFinite(stopAnchor.level)) {
    const riskPS = Math.max(0, entryPrice - stopAnchor.level);
    const rr = Number.isFinite(target as number) && (target as number)! > entryPrice && riskPS > 0 ? ((target as number)! - entryPrice) / riskPS : null;
    bits.push(`Risk was framed against ${stopAnchor.kind} near $${stopAnchor.level.toFixed(2)} for about $${riskPS.toFixed(2)} per share of risk${rr != null ? ` and an initial reward-to-risk near ${rr.toFixed(2)}×` : ""}.`);
  }

  if (relVol5 != null && relVol5 < 0.9) bits.push(`We noted light volume at entry and were ready to exit if momentum faded.`);
  if (typeof orLow === "number") bits.push(`A clean break below the opening-range low near $${orLow.toFixed(2)} would invalidate the setup.`);
  if (vwap != null) bits.push(`A decisive move under VWAP (around $${vwap.toFixed(2)}) would also weaken the long thesis.`);

  if (recExplanation) bits.push(`The picker’s saved note at selection time said: “${recExplanation}”.`);

  return bits.join(" ");
}

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

  let spreadNote = "";
  try {
    const tight = await spreadGuardOK(symbol, 0.005);
    spreadNote = tight ? "bid–ask spread looked tight" : "bid–ask spread was a bit wide";
  } catch {
    spreadNote = "spread check unavailable";
  }

  const stopAnchor =
    vwap != null && last.low >= vwap * 0.995 ? { kind: "VWAP hold", level: vwap } :
    or ? { kind: "OR low", level: or.low } : null;

  const dayHighSoFar = Math.max(...upTo.map((c) => c.high));
  const target = Math.max(dayHighSoFar, or?.high ?? -Infinity);

  return renderWhyTradeReport({
    symbol,
    entryPrice: last.close,
    entryET: `${toET(last.date).toISOString()}`,
    orHigh: or?.high ?? null,
    orLow: or?.low ?? null,
    lastClose: last.close,
    vwap,
    vwapSlope,
    relVol5: rvol5,
    trend,
    float,
    avgVolume: quote.avgVolume ?? null,
    marketCap: quote.marketCap ?? null,
    spreadNote,
    stopAnchor,
    target,
    recExplanation: null,
  });
}

/* ───────────────── Live facts Q&A ───────────────── */
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
  const system =
    "You are a grounded trading copilot. Answer using ONLY the provided facts (JSON). " +
    "If a detail isn't present, say you don't know yet. Be concise, neutral, and avoid advice. " +
    "Include numeric levels like price/VWAP/OR when relevant. 1–6 short sentences max.";
  const user = `Question: ${userQuestion}\n\nFacts (JSON):\n${JSON.stringify(facts)}`;
  return await safeChat([{ role: "system", content: system }, { role: "user", content: user }]);
}

/* ───────────────── No-trade explainer ───────────────── */
function humanizeNoTradeReasons(tick: any): string {
  if (!tick) return "I couldn't fetch the bot’s latest status.";
  const parts: string[] = [];
  if (tick.skipped === "not_weekday") parts.push("Market was closed (not a weekday).");

  const dbg = tick.debug || {};
  const reasons: string[] = Array.isArray(dbg.reasons) ? dbg.reasons : [];
  const info = tick.info || {};
  const liq = info.liquidity || {};

  if (reasons.includes("scan_no_ai_pick_yet")) parts.push("No AI pick was available during the scan window.");
  if (reasons.includes("scan_no_armed_signal_after_eval")) parts.push("Signals didn’t arm (no momentum/dip confirmation).");
  if (reasons.some((r) => r.startsWith("force_spread_guard_fail_"))) parts.push("Spread guard blocked entries in the force window.");

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
  if (perTickers.length) parts.push(`Per-ticker checks — ${perTickers.join(" | ")}`);

  const liqLine = (liq?.minSharesAbs || liq?.floatPctPerMin || liq?.minDollarVol)
    ? `Liquidity thresholds: min shares ${liq.minSharesAbs?.toLocaleString?.() ?? "?"}, float/min ${(liq.floatPctPerMin*100)?.toFixed?.(3) ?? "?"}%, dollar vol $${liq.minDollarVol?.toLocaleString?.() ?? "?"} (per 1-min bar).`
    : "";
  if (liqLine) parts.push(liqLine);

  if (info?.scan_0930_0944 === false && info?.force_0945_0946 === false) parts.push("We were outside the scan/force windows.");

  return parts.length ? parts.join(" ") : "No trade executed; bot did not meet entry conditions.";
}
async function explainNoTradeToday(base: string) {
  const tick = await fetchBotTick(base);
  const draft = humanizeNoTradeReasons(tick);
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

    // in-range trades
    const tradesInRange = await prisma.trade.findMany({
      where: { at: { gte: startUTC, lte: endUTC } },
      orderBy: { id: "asc" },
    }) as unknown as DbTrade[];

    // seed with prior trades (carry-in lots per ticker)
    const priorTrades = await prisma.trade.findMany({
      where: { at: { lt: startUTC } },
      orderBy: { id: "asc" },
    }) as unknown as DbTrade[];
    const seedLots = buildSeedLotsBefore(priorTrades);

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
        "- Why did we trade ABCD?  ← detailed paragraph\n" +
        "- Why didn’t we trade today?\n" +
        "- What price did we sell/exit ABCD?\n" +
        "- What price did we buy/enter ABCD?\n" +
        "- Ask about a ticker with $ (e.g., “Is $ABCD above VWAP?”)";
      return NextResponse.json({ reply });
    }

    if (intent === "why_no_trade") {
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

    /* ─────────────── P&L (weekly breakdown with seeds & per-ticker FIFO) ─────────────── */
    if (intent === "pnl") {
      const weeklyQuery =
        /\b(this week|for the week|week to date|wtd|last week|week)\b/i.test(msg) ||
        /week/i.test(label);

      if (weeklyQuery) {
        const byDay = realizedByDayFIFO(tradesInRange, seedLots);
        const days = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));

        const total = days.reduce((s, [, v]) => s + v, 0);
        const greenSum = days.filter(([, v]) => v > 0).reduce((s, [, v]) => s + v, 0);
        const redSum = days.filter(([, v]) => v < 0).reduce((s, [, v]) => s + v, 0);

        if (!days.length) {
          const draft = tone.fun(`no realized trades ${label}, so realized P&L is $0.00.`);
          return NextResponse.json({ reply: await maybePolishReply(draft, { realized: 0, label }) });
        }

        const lines: string[] = [];
        lines.push(tone.fun(`realized P&L ${label}: ${money(total)}.`));
        lines.push(`Green days sum: ${moneyFlat(greenSum)} • Red days sum: ${moneyFlat(redSum)}`);
        for (const [ymd, val] of days) lines.push(`• ${ymd}: ${moneyFlat(val)}`);

        return NextResponse.json({
          reply: await maybePolishReply(lines.join("\n"), { total, greenSum, redSum, days, label }, { maxLen: 1200 })
        });
      }

      // Fallback: non-week queries (today, yesterday, this month, last N days, etc.)
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

    /* WHY TRADE — detailed paragraph */
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
      const priceNum = asNumber(entryTrade.price);

      const recRows = await prisma.recommendation.findMany({
        where: { ticker, at: { gte: new Date(startUTC.getTime() - 12 * 60 * 60 * 1000), lte: new Date(endUTC.getTime() + 12 * 60 * 60 * 1000) } },
        orderBy: { at: "desc" }, take: 1,
      }) as unknown as DbReco[];
      const recExp = (recRows?.[0]?.explanation || "").trim() || null;

      const base = getBaseUrl(req);
      const deep = await buildWhyTradeDeep(base, ticker, new Date(entryTrade.at));

      const header = `We ${side === "BUY" ? "entered" : "executed a " + side} ${ticker} ${label} around $${priceNum.toFixed(2)} (${whenET.ymd} ${whenET.hms} ET).`;
      const report = deep
        ? (recExp ? `${deep} The picker’s saved note said: “${recExp}”.` : deep)
        : (recExp ? `We didn’t capture intraday metrics at entry. The picker’s note was: “${recExp}”.` : "");

      const finalReply = report ? `${header} ${report}` : `${header} I didn’t capture intraday metrics at the exact entry time, but I’ll log them on future entries.`;
      return NextResponse.json({ reply: finalReply });
    }

    /* WHY PICK (non-traded allowed) — paragraph with Top-1 vs Top-2 comparison */
    if (intent === "why_pick") {
      const ticker = chooseTickerFromContext(msg, tradesInRange, { requireTraded: false, allowBare: true });
      if (!ticker) {
        return NextResponse.json({ reply: "Tell me the ticker (e.g., “Why did the AI pick ABCD today?”) and I’ll explain in plain English." });
      }
      const base = getBaseUrl(req);
      const narrative = await buildWhyPickNarrative(base, ticker).catch(() => null);

      if (!narrative) {
        const { startUTC: s, endUTC: e } = parseDateRangeETFromMessage("today", new Date());
        const rec = await prisma.recommendation.findFirst({
          where: { ticker, at: { gte: s, lte: e } },
          orderBy: { at: "desc" },
        }) as any;
        if (rec?.explanation) {
          const whenET = toETParts(new Date(rec.at));
          const price = asNumber(rec.price).toFixed(2);
          return NextResponse.json({
            reply:
              `The picker highlighted ${ticker} around $${price} (${whenET.ymd} ${whenET.hms} ET). ` +
              `Reason saved at selection time: “${String(rec.explanation).trim()}”.`
          });
        }
        return NextResponse.json({
          reply: `I couldn't find a live explanation for ${ticker} today. Make sure your recommendation pipeline stores its reason.`
        });
      }

      return NextResponse.json({ reply: narrative });
    }

    /* Free-form stock Q&A (requires $TICKER) */
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
      parts.push(`${facts.symbol}: ${facts.price != null ? `$${(facts.price as number).toFixed?.(2) ?? facts.price}` : "price n/a"}.`);
      if (facts.vwap != null) parts.push(`VWAP ${Number(facts.vwap).toFixed(2)}${facts.aboveVWAP != null ? facts.aboveVWAP ? " (above)" : " (below)" : ""}.`);
      if (facts.openingRange?.high != null) parts.push(`ORH ${Number(facts.openingRange.high).toFixed(2)}.`);
      if (facts.relVol5 != null) parts.push(`RelVol(5m) ${Number(facts.relVol5).toFixed(2)}×.`);
      if (facts.dayHigh != null && facts.dayLow != null) parts.push(`Day ${Number(facts.dayLow).toFixed(2)}–${Number(facts.dayHigh).toFixed(2)}.`);
      if (facts.vwapSlope != null) parts.push(`VWAP slope ${Number(facts.vwapSlope) > 0 ? "up" : Number(facts.vwapSlope) < 0 ? "down" : "flat"}.`);
      return NextResponse.json({ reply: parts.join(" ") });
    }

    // Default status
    const realized = realizedFIFO(tradesInRange);
    const traded = summarizeTrades(tradesInRange);

    const pieces: string[] = [];
    pieces.push(openPos?.open ? tone.holding(openPos) : tone.flat());
    if (traded === "No trades in that range.") {
      const base2 = getBaseUrl(req);
      const why = await explainNoTradeToday(base2).catch(() => null);
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
