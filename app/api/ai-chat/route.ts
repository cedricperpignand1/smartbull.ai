// app/api/ai-chat/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { spreadGuardOK } from "@/lib/alpaca";

/* ──────────────────────────────────────────────────────────
   US/Eastern helpers (no ICU required)
   ────────────────────────────────────────────────────────── */
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
  const start = Date.UTC(y, 2, secondSundayUTC(y, 2), 7, 0, 0); // 2nd Sun Mar @ 07:00 UTC
  const end = Date.UTC(y, 10, firstSundayUTC(y, 10), 6, 0, 0);  // 1st Sun Nov @ 06:00 UTC
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

/* ──────────────────────────────────────────────────────────
   Types (DB-aligned with your schema)
   ────────────────────────────────────────────────────────── */
type DbTrade = {
  id: number;
  side: "BUY" | "SELL" | string;
  ticker: string;
  price: any; // Prisma Decimal
  shares: number;
  at: Date;
  filledAt?: Date | null;
  filledPrice?: any | null;
  // reason?: string | null; // optional future field
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

/* ──────────────────────────────────────────────────────────
   Math / formatting helpers
   ────────────────────────────────────────────────────────── */
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
    if (side === "BUY") {
      lots.push({ qty: t.shares, cost: p });
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
    }
  }
  return realized;
}
function realizedForTicker(tradesAsc: DbTrade[], ticker: string) {
  const rows = tradesAsc.filter(t => t.ticker.toUpperCase() === ticker.toUpperCase());
  return realizedFIFO(rows);
}
const money = (n: number) => (n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`);

/* ──────────────────────────────────────────────────────────
   Human tone helpers
   ────────────────────────────────────────────────────────── */
const tone = {
  open: (s: string) => `Okay — ${s}`,
  flat: () => "I’m flat right now.",
  holding: (pos: DbPos) =>
    `Currently holding ${pos.shares} ${pos.ticker} @ $${asNumber(pos.entryPrice).toFixed(2)}.`,
  fun: (s: string) => `Alrighty — ${s} 🙂`,
};

/* ──────────────────────────────────────────────────────────
   Intent + NLU
   ────────────────────────────────────────────────────────── */
type Intent =
  | "what_traded"
  | "pnl"
  | "in_position"
  | "why_trade"
  | "why_pick"
  | "sell_price"
  | "entry_price"
  | "status"
  | "help";

function extractTicker(msg: string): string | null {
  // Grab $VEEE or bare VEEE; avoid obvious words like WHAT/SELL
  const dollar = msg.toUpperCase().match(/\$([A-Z]{1,5})(?:\.[A-Z]{1,2})?\b/);
  if (dollar?.[1]) return dollar[1];
  const m = msg.toUpperCase().match(/\b([A-Z]{1,5})(?:\.[A-Z]{1,2})?\b/);
  const cand = m?.[1] || null;
  const blacklist = new Set(["WHAT","YOU","SELL","SOLD","PRICE","BUY","BOUGHT","ENTRY","EXIT","AVERAGE","COST","IT","WE","DID","AT","WHERE"]);
  return cand && !blacklist.has(cand) ? cand : null;
}

function parseIntent(q: string): Intent {
  const m = q.toLowerCase();

  // SELL / EXIT PRICE (very liberal)
  if (
    /\b(exit|sell|sold|selled|close|closed|get out|got out|take profit|tp)\b/.test(m) &&
    /\b(price|avg|average|at|fill|fills?)\b/.test(m)
  ) return "sell_price";

  // ENTRY / BUY PRICE (very liberal)
  if (
    (/\b(buy|bought|enter|entered|entry|get in|got in|added|add)\b/.test(m) &&
     /\b(price|avg|average|cost|fill|fills?)\b/.test(m)) ||
    /\b(average cost|avg cost|avg entry|average entry)\b/.test(m)
  ) return "entry_price";

  // WHY TRADE
  if (/(why).*(trade|traded|buy|bought|sell|sold|enter|entry|took|take|long|short)/.test(m)) return "why_trade";

  if (/(what|which).*(trade|trades|traded|tickers?)/.test(m)) return "what_traded";
  if (/((did|do).*(make|made|lose).*(money|profit|p&?l)|p&?l|green|red)/.test(m)) return "pnl";
  if (/(are|am|you).*(in|holding).*(position)|open position/.test(m)) return "in_position";
  if (/(why).*(ai|bot).*(pick|choose|chose|selected?)/.test(m)) return "why_pick";
  if (/help|what can you do|commands?/.test(m)) return "help";
  return "status";
}

/** Parse ET date range from message. Returns [startUTC, endUTC] inclusive + label. */
function parseDateRangeETFromMessage(msg: string, nowUTC: Date): { startUTC: Date; endUTC: Date; label: string } {
  const lower = msg.toLowerCase();

  const on = lower.match(/\b(on\s+)?(\d{4})[-/](\d{2})[-/](\d{2})\b/);
  if (on) {
    const Y = Number(on[2]), M = Number(on[3]), D = Number(on[4]);
    const anchor = new Date(Date.UTC(Y, M - 1, D, 12));
    const start = startOfETDayUTC(anchor);
    const end = endOfETDayUTC(anchor);
    return { startUTC: start, endUTC: end, label: `${Y}-${String(M).padStart(2,"0")}-${String(D).padStart(2,"0")}` };
  }

  const between = lower.match(/\bbetween\s+(\d{4})[-/](\d{2})[-/](\d{2})\s+(and|to)\s+(\d{4})[-/](\d{2})[-/](\d{2})\b/);
  if (between) {
    const Y1 = Number(between[1]), M1 = Number(between[2]), D1 = Number(between[3]);
    const Y2 = Number(between[5]), M2 = Number(between[6]), D2 = Number(between[7]);
    const a = new Date(Date.UTC(Y1, M1 - 1, D1, 12));
    const b = new Date(Date.UTC(Y2, M2 - 1, D2, 12));
    const start = startOfETDayUTC(a);
    const end = endOfETDayUTC(b);
    return { startUTC: start, endUTC: end, label: `${Y1}-${String(M1).padStart(2,"0")}-${String(D1).padStart(2,"0")} → ${Y2}-${String(M2).padStart(2,"0")}-${String(D2).padStart(2,"0")}` };
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
    const dow = new Date(etAnchor).getUTCDay(); // 0 Sun
    const daysFromMon = (dow + 6) % 7; // Mon=0
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
    const end = endOfETDayUTC(lastDay);
    return { startUTC: start, endUTC: end, label: "this month" };
  }

  if (/\byesterday\b/.test(lower)) {
    const todayStart = startOfETDayUTC(nowUTC);
    const yStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    const yEnd = new Date(todayStart.getTime() - 1);
    return { startUTC: yStart, endUTC: yEnd, label: "yesterday" };
  }

  return { startUTC: startOfETDayUTC(nowUTC), endUTC: endOfETDayUTC(nowUTC), label: "today" };
}

/* ──────────────────────────────────────────────────────────
   Data fetchers (schema-aligned)
   ────────────────────────────────────────────────────────── */
async function fetchTradesInRange(startUTC: Date, endUTC: Date): Promise<DbTrade[]> {
  const trades = (await prisma.trade.findMany({
    where: { at: { gte: startUTC, lte: endUTC } },
    orderBy: { id: "asc" },
  })) as unknown as DbTrade[];
  return trades;
}
async function fetchOpenPosition(): Promise<DbPos | null> {
  return (await prisma.position.findFirst({
    where: { open: true },
    orderBy: { id: "desc" },
  })) as unknown as DbPos | null;
}
async function fetchLatestRecommendationForTickerInWindow(
  ticker: string,
  startUTC: Date,
  endUTC: Date
): Promise<DbReco | null> {
  const rows = (await prisma.recommendation.findMany({
    where: {
      ticker: ticker.toUpperCase(),
      at: {
        gte: new Date(startUTC.getTime() - 12 * 60 * 60 * 1000),
        lte: new Date(endUTC.getTime() + 12 * 60 * 60 * 1000),
      },
    },
    orderBy: { at: "desc" },
    take: 1,
  })) as unknown as DbReco[];
  return rows?.[0] ?? null;
}

/* ──────────────────────────────────────────────────────────
   Internal API + market helpers (for rich “why”)
   ────────────────────────────────────────────────────────── */
function getBaseUrl(req: Request) {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = (req.headers.get("x-forwarded-proto") || "http").split(",")[0].trim();
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };
type QuoteLite = { price?: number | null; avgVolume?: number | null; marketCap?: number | null };

async function fetchCandles1m(base: string, symbol: string, limit = 360): Promise<Candle[]> {
  try {
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
  } catch {
    return [];
  }
}

async function fetchQuoteLite(base: string, symbol: string): Promise<QuoteLite> {
  try {
    const res = await fetch(`${base}/api/fmp/quote?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    const j = await res.json();
    const row = (Array.isArray(j) ? j[0] : j) || {};
    return {
      price: Number(row.price),
      avgVolume: Number(row.avgVolume || row.avgVolume10Day || row.averageVolume),
      marketCap: Number(row.marketCap),
    };
  } catch {
    return {};
  }
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

function toET(dateIso: string) {
  return new Date(new Date(dateIso).toLocaleString("en-US", { timeZone: "America/New_York" }));
}
function isSameETDay(d: Date, ymd: string) {
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}` === ymd;
}
function yyyyMmDdETFromUTC(utc: Date) {
  const parts = toETParts(utc);
  return parts.ymd;
}

/* Opening range 9:30–9:33 ET */
function computeOpeningRange(candles: Candle[], ymd: string) {
  const win = candles.filter((c) => {
    const d = toET(c.date);
    return isSameETDay(d, ymd) && d.getHours() === 9 && d.getMinutes() >= 30 && d.getMinutes() <= 33;
  });
  if (!win.length) return null;
  const high = Math.max(...win.map((c) => c.high));
  const low = Math.min(...win.map((c) => c.low));
  return { high, low };
}

/* VWAP from 9:30 up to cutoff */
function computeVWAPUpTo(candles: Candle[], ymd: string, cutoffET: Date) {
  const session = candles.filter((c) => {
    const d = toET(c.date);
    const mins = d.getHours() * 60 + d.getMinutes();
    const cut = cutoffET.getHours() * 60 + cutoffET.getMinutes();
    return isSameETDay(d, ymd) && mins >= 9 * 60 + 30 && mins <= cut;
  });
  if (!session.length) return null;
  let pv = 0, vol = 0;
  for (const c of session) {
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
  }
  return vol > 0 ? pv / vol : null;
}

/* 5-min relative volume at cutoff */
function computeRelVol5(candles: Candle[], ymd: string, cutoffET: Date, N = 5) {
  const day = candles.filter((c) => isSameETDay(toET(c.date), ymd) && toET(c.date).getTime() <= cutoffET.getTime());
  if (day.length < N + 1) return null;
  const last = day[day.length - 1];
  const prior = day.slice(-1 - N, -1);
  const avgPrior = prior.reduce((s, c) => s + c.volume, 0) / N;
  if (!avgPrior) return null;
  return last.volume / avgPrior;
}

/* VWAP slope (compare current vwap vs vwap 3 minutes earlier) */
function computeVWAPSlope(candles: Candle[], ymd: string, cutoffET: Date, backMinutes = 3) {
  const backCut = new Date(cutoffET.getTime() - backMinutes * 60_000);
  const v1 = computeVWAPUpTo(candles, ymd, cutoffET);
  const v0 = computeVWAPUpTo(candles, ymd, backCut);
  if (v1 == null || v0 == null) return null;
  return v1 - v0; // positive = up slope
}

/* Trend check (last 3 closes making higher highs/lows) */
function last3Trend(candles: Candle[], ymd: string, cutoffET: Date) {
  const day = candles.filter((c) => isSameETDay(toET(c.date), ymd) && toET(c.date).getTime() <= cutoffET.getTime());
  const w = day.slice(-3);
  if (w.length < 3) return null;
  const higherCloses = w[2].close > w[1].close && w[1].close > w[0].close;
  const higherLows = w[2].low >= w[1].low && w[1].low >= w[0].low;
  return { higherCloses, higherLows };
}

/* “Why we traded” — rich explanation built around the entry candle */
async function buildWhyTradeDeep(
  base: string,
  symbol: string,
  entryUTC: Date
): Promise<string | null> {
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

  const nearOrBreak =
    or ? (last.close > or.high ? "breaking OR high" : (last.close >= or.high * 0.995 ? "testing OR high" : "")) : "";

  // Spread check (best-effort)
  let spreadNote = "";
  try {
    const tight = await spreadGuardOK(symbol, 0.005);
    spreadNote = tight ? "spread looked tight" : "spread was a bit wide";
  } catch {
    spreadNote = "spread check unavailable";
  }

  // Risk anchors
  const stopAnchor =
    vwap != null && last.low >= vwap * 0.995
      ? { kind: "VWAP hold", level: vwap }
      : or
      ? { kind: "OR low", level: or.low }
      : null;

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
    const rStr =
      rvol5 >= 1.2 ? `${rvol5.toFixed(2)}× (elevated)` :
      rvol5 >= 0.9 ? `${rvol5.toFixed(2)}× (normal-ish)` :
      `${rvol5.toFixed(2)}× (light)`;
    bits.push(`5-min relative volume ${rStr}`);
  }

  const liq: string[] = [];
  const fnum = Number(float);
  if (Number.isFinite(fnum) && fnum > 0) {
    if (fnum < 20_000_000) liq.push("low float — can move fast");
    else if (fnum < 60_000_000) liq.push("moderate float");
  }
  if (Number.isFinite(Number(quote.avgVolume)) && quote.avgVolume! > 0) {
    liq.push(`avg volume ~${Math.round(quote.avgVolume!).toLocaleString()}`);
  }
  if (Number.isFinite(Number(quote.marketCap)) && quote.marketCap! > 0) {
    const mc = quote.marketCap!;
    const mcStr = mc < 300e6 ? "small-cap" : mc < 2e9 ? "mid-cap" : "large-cap";
    liq.push(mcStr);
  }
  if (liq.length) bits.push(liq.join(", "));
  if (spreadNote) bits.push(spreadNote);

  const lines: string[] = [];
  lines.push(`Setup read: ${bits.length ? bits.join("; ") : "no strong signals captured at entry time"}`);

  if (stopAnchor && Number.isFinite(stopAnchor.level)) {
    const riskPS = Math.max(0, last.close - stopAnchor.level);
    const rr =
      Number.isFinite(target) && target > last.close && riskPS > 0
        ? (target - last.close) / riskPS
        : null;
    lines.push(
      `Risk frame: stop ~${stopAnchor.kind} ($${stopAnchor.level.toFixed(2)}), ` +
      `risk/Share ≈ $${riskPS.toFixed(2)}${rr != null ? `, R:R ≈ ${rr.toFixed(2)}x to ${target === dayHighSoFar ? "day high" : "OR high"}` : ""}.`
    );
  }

  if (rvol5 != null && rvol5 < 0.9) {
    lines.push(`Note: volume was lighter than average at entry; we kept expectations modest and respected the stop.`);
  }

  return lines.join("\n");
}

/* ──────────────────────────────────────────────────────────
   Formatters & tiny helpers
   ────────────────────────────────────────────────────────── */
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
function chooseTickerFromContext(q: string, trades: DbTrade[]): string | null {
  let t = extractTicker(q);
  const traded = Array.from(new Set(trades.map(r => r.ticker.toUpperCase())));
  if (t && traded.includes(t.toUpperCase())) return t.toUpperCase();
  if (!t && traded.length === 1) return traded[0];
  return t ? t.toUpperCase() : null;
}

/* ──────────────────────────────────────────────────────────
   POST (main chat)
   ────────────────────────────────────────────────────────── */
export async function POST(req: Request) {
  try {
    const { message } = await req.json();
    const msg: string = String(message || "");
    const nowUTC = new Date();

    const intent = parseIntent(msg);
    const { startUTC, endUTC, label } = parseDateRangeETFromMessage(msg, nowUTC);
    const [tradesInRange, openPos] = await Promise.all([
      fetchTradesInRange(startUTC, endUTC),
      fetchOpenPosition(),
    ]);

    if (intent === "help") {
      return NextResponse.json({
        reply:
          "Here’s what I can do:\n" +
          "- “What did we trade today / yesterday / last 5 days?”\n" +
          "- “What’s my P&L today / this week / this month?”\n" +
          "- “Are we holding anything?”\n" +
          "- “Why did we trade ABCD?”\n" +
          "- “What price did we **sell/exit** ABCD?” (fills + avg)\n" +
          "- “What price did we **buy/enter** ABCD?” (fills + avg)\n" +
          "- “Why did the AI pick ABCD?”",
      });
    }

    if (intent === "what_traded") {
      const summary = summarizeTrades(tradesInRange);
      const reply = summary === "No trades in that range."
        ? tone.fun(`no trades ${label}.`)
        : tone.fun(`trades ${label}: ${summary}`);
      return NextResponse.json({ reply });
    }

    if (intent === "pnl") {
      const realized = realizedFIFO(tradesInRange);
      if (!tradesInRange.length) {
        return NextResponse.json({ reply: tone.fun(`no trades ${label}, so realized P&L is $0.00.`) });
      }
      return NextResponse.json({ reply: tone.fun(`realized P&L ${label}: ${money(realized)}.`) });
    }

    if (intent === "in_position") {
      const reply = openPos?.open ? tone.holding(openPos) : tone.flat();
      return NextResponse.json({ reply: tone.fun(reply) });
    }

    /* ───────── SELL PRICE: exits (fills + weighted avg + per-ticker realized) ───────── */
    if (intent === "sell_price") {
      const ticker = chooseTickerFromContext(msg, tradesInRange);
      if (!ticker) {
        const tradedTickers = Array.from(new Set(tradesInRange.map(t => t.ticker.toUpperCase())));
        if (tradedTickers.length > 1) {
          return NextResponse.json({
            reply: tone.fun(`got a few names ${label}: ${tradedTickers.join(", ")}. Which one should I pull exits for?`),
          });
        }
        return NextResponse.json({ reply: tone.fun(`no trades ${label}, so no exits to report.`) });
      }
      const rowsForTicker = tradesInRange.filter(t => t.ticker.toUpperCase() === ticker);
      const sells = rowsForTicker.filter(t => String(t.side).toUpperCase() === "SELL");
      const buys = rowsForTicker.filter(t => String(t.side).toUpperCase() === "BUY");

      if (!rowsForTicker.length) return NextResponse.json({ reply: tone.fun(`didn’t see ${ticker} ${label}.`) });

      if (!sells.length) {
        if (openPos?.open && openPos.ticker.toUpperCase() === ticker) {
          return NextResponse.json({ reply: tone.fun(`haven’t sold ${ticker} yet — still holding.`) });
        }
        return NextResponse.json({
          reply: tone.fun(`no sell fills for ${ticker} ${label}. Try “yesterday” or “last 5 days” if it was earlier.`),
        });
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

    /* ───────── ENTRY PRICE: buys (fills + weighted avg; if holding, show live entry) ───────── */
    if (intent === "entry_price") {
      const ticker = chooseTickerFromContext(msg, tradesInRange) || (openPos?.open ? openPos.ticker.toUpperCase() : null);
      if (!ticker) {
        const tradedTickers = Array.from(new Set(tradesInRange.map(t => t.ticker.toUpperCase())));
        if (tradedTickers.length > 1) {
          return NextResponse.json({
            reply: tone.fun(`I’ve got multiple names ${label}: ${tradedTickers.join(", ")}. Which entry do you want?`),
          });
        }
        return NextResponse.json({ reply: tone.fun(`no trades ${label} yet — nothing to enter.`) });
      }

      // Prefer current open position entry if it matches
      if (openPos?.open && openPos.ticker.toUpperCase() === ticker) {
        const et = toETParts(new Date(openPos.entryAt));
        const price = asNumber(openPos.entryPrice).toFixed(2);
        return NextResponse.json({
          reply: tone.fun(`current ${ticker} entry: $${price} (${et.ymd} ${et.hms} ET).`),
        });
      }

      const rowsForTicker = tradesInRange.filter(t => t.ticker.toUpperCase() === ticker);
      const buys = rowsForTicker.filter(t => String(t.side).toUpperCase() === "BUY");

      if (!rowsForTicker.length || !buys.length) {
        return NextResponse.json({
          reply: tone.fun(`no buy fills for ${ticker} ${label}. If it was earlier, try “yesterday” or “last 5 days”.`),
        });
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

    /* ───────── WHY TRADE: friendly + deep explanation ───────── */
    if (intent === "why_trade") {
      const tradedTickers = Array.from(new Set(tradesInRange.map(t => t.ticker.toUpperCase())));
      let ticker = chooseTickerFromContext(msg, tradesInRange);
      if (!ticker) {
        if (tradedTickers.length === 1) ticker = tradedTickers[0];
        else if (tradedTickers.length > 1) {
          return NextResponse.json({
            reply: tone.fun(`I’ve got a few names ${label}: ${tradedTickers.join(", ")}. Which one do you want the why for?`),
          });
        } else {
          return NextResponse.json({ reply: tone.fun(`no trades ${label}, so there’s nothing to explain.`) });
        }
      }

      const relevant = tradesInRange.filter(t => t.ticker.toUpperCase() === ticker);
      if (!relevant.length) return NextResponse.json({ reply: tone.fun(`didn’t see ${ticker} ${label}.`) });

      const entryTrade = relevant.find(t => String(t.side).toUpperCase() === "BUY") || relevant[0];
      const whenET = toETParts(new Date(entryTrade.at));
      const side = String(entryTrade.side).toUpperCase();
      const priceStr = asNumber(entryTrade.price).toFixed(2);

      // 1) optional future Trade.reason
      let tradeReason: string | null = null as any;
      try {
        // const specific = await prisma.trade.findFirst({ where: { id: entryTrade.id }, select: { reason: true } });
        // tradeReason = (specific?.reason || "").trim() || null;
      } catch {}

      // 2) saved AI pick explanation
      const rec = await fetchLatestRecommendationForTickerInWindow(ticker, startUTC, endUTC);
      let recExp = (rec?.explanation || "").trim() || null;

      // 3) deep heuristic at entry time
      const base = getBaseUrl(req);
      const deep = await buildWhyTradeDeep(base, ticker, new Date(entryTrade.at));

      const header =
        `We ${side === "BUY" ? "entered" : "executed a " + side} ${ticker} ` +
        `${label} around $${priceStr} (${whenET.ymd} ${whenET.hms} ET).`;

      const reasonBlock =
        tradeReason
          ? `Reason: ${tradeReason}`
          : recExp
          ? `Reason (from the AI pick): ${recExp}`
          : deep
          ? deep
          : "I didn’t capture a thesis at the time, but I’ll log one on future entries.";

      return NextResponse.json({ reply: `${header}\n${reasonBlock}` });
    }

    if (intent === "why_pick") {
      const ticker = chooseTickerFromContext(msg, tradesInRange);
      if (!ticker) {
        return NextResponse.json({
          reply: tone.fun("tell me the ticker (e.g., “Why did the AI pick ABCD today?”) and I’ll pull it up."),
        });
      }
      const rec = await fetchLatestRecommendationForTickerInWindow(ticker, startUTC, endUTC);
      if (rec) {
        const whenET = toETParts(new Date(rec.at));
        const price = asNumber(rec.price).toFixed(2);
        const exp = (rec.explanation || "").trim();
        if (exp) {
          return NextResponse.json({
            reply: tone.fun(
              `AI picked ${ticker} ${label} around $${price} (${whenET.ymd} ${whenET.hms} ET). Reason: ${exp}`
            ),
          });
        }
        return NextResponse.json({
          reply: tone.fun(
            `AI picked ${ticker} ${label} around $${price} (${whenET.ymd} ${whenET.hms} ET), but no explanation was saved.`
          ),
        });
      }
      return NextResponse.json({
        reply: tone.fun(
          `couldn’t find a saved recommendation for ${ticker} ${label}. Make sure the /api/recommendation route stores the explanation.`
        ),
      });
    }

    // Default status (friendly)
    const realized = realizedFIFO(tradesInRange);
    const traded = summarizeTrades(tradesInRange);
    const parts: string[] = [];

    parts.push(openPos?.open ? tone.holding(openPos) : tone.flat());
    if (traded === "No trades in that range.") parts.push(`No trades ${label}.`);
    else parts.push(`Trades ${label}: ${traded}.`);
    if (tradesInRange.length) parts.push(`Realized P&L ${label}: ${money(realized)}.`);

    return NextResponse.json({ reply: tone.fun(parts.join(" ")) });
  } catch (e: any) {
    return NextResponse.json(
      { reply: `Sorry — I couldn’t process that. ${e?.message || "Unknown error."}` },
      { status: 200 }
    );
  }
}

/* ──────────────────────────────────────────────────────────
   GET ?debug=1 – view last trades in ET (uses Trade.at)
   ────────────────────────────────────────────────────────── */
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("debug") !== "1") {
    return NextResponse.json({ reply: "Send a POST with { message }." });
  }
  const trades = (await prisma.trade.findMany({ orderBy: { id: "desc" }, take: 20 })) as unknown as DbTrade[];
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
