// app/api/ai-chat/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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
  const start = Date.UTC(y, 2, secondSundayUTC(y, 2), 7, 0, 0); // 2nd Sun Mar @ 07:00 UTC (2a ET)
  const end = Date.UTC(y, 10, firstSundayUTC(y, 10), 6, 0, 0); // 1st Sun Nov @ 06:00 UTC (2a ET)
  const t = utc.getTime();
  return t >= start && t < end;
}
function toETParts(utcInstant: Date) {
  const offsetMin = isDST_US_Eastern(utcInstant) ? -240 : -300;
  const shifted = new Date(utcInstant.getTime() + offsetMin * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).toString().padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  const ss = String(shifted.getUTCSeconds()).padStart(2, "0");
  return { ymd: `${y}-${m}-${d}`, hms: `${hh}:${mm}:${ss}` };
}
function startOfETDayUTC(utcInstant: Date): Date {
  const parts = toETParts(utcInstant);
  const [Y, M, D] = parts.ymd.split("-").map(Number);
  const anchorNoonUTC = new Date(Date.UTC(Y, M - 1, D, 12, 0, 0));
  const offsetMin = isDST_US_Eastern(utcInstant) ? 240 : 300;
  return new Date(anchorNoonUTC.getTime() - 12 * 60 * 60 * 1000 + offsetMin * 60_000);
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
  // reason?: string | null; // <— add in schema when ready
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
const money = (n: number) => (n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`);

/* ──────────────────────────────────────────────────────────
   Intent + NLU
   ────────────────────────────────────────────────────────── */
type Intent = "what_traded" | "pnl" | "in_position" | "why_trade" | "why_pick" | "status" | "help";
function extractTicker(msg: string): string | null {
  const m = msg.toUpperCase().match(/\b([A-Z]{1,5})(?:\.[A-Z]{1,2})?\b/);
  return m?.[1] || null;
}
function parseIntent(q: string): Intent {
  const m = q.toLowerCase();
  if (/(what|which).*(trade|trades|traded|tickers?)/.test(m)) return "what_traded";
  if (/((did|do).*(make|made|lose).*(money|profit|p&?l)|p&?l|green|red)/.test(m)) return "pnl";
  if (/(are|am|you).*(in|holding).*(position)|open position/.test(m)) return "in_position";
  if (/(why).*(take|took).*(trade)/.test(m)) return "why_trade";
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
      at: { gte: new Date(startUTC.getTime() - 12 * 60 * 60 * 1000), lte: new Date(endUTC.getTime() + 12 * 60 * 60 * 1000) },
    },
    orderBy: { at: "desc" },
    take: 1,
  })) as unknown as DbReco[];
  return rows?.[0] ?? null;
}

/* ──────────────────────────────────────────────────────────
   Formatters
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
          "Try:\n" +
          "- What trades did you take today / yesterday / last 5 days / between 2025-08-20 and 2025-08-23?\n" +
          "- What’s my P&L today / this week / this month?\n" +
          "- Are we holding anything?\n" +
          "- Why did you take this trade?\n" +
          "- Why did the AI pick ABCD?",
      });
    }

    if (intent === "what_traded") {
      const summary = summarizeTrades(tradesInRange);
      return NextResponse.json({
        reply: summary === "No trades in that range." ? `No trades ${label}.` : `Trades ${label}: ${summary}`,
      });
    }

    if (intent === "pnl") {
      const realized = realizedFIFO(tradesInRange);
      if (!tradesInRange.length) return NextResponse.json({ reply: `No trades ${label}, so realized P&L is $0.00.` });
      return NextResponse.json({ reply: `Realized P&L ${label}: ${money(realized)}.` });
    }

    if (intent === "in_position") {
      return NextResponse.json({
        reply: openPos?.open
          ? `Yes, holding ${openPos.shares} ${openPos.ticker} @ $${asNumber(openPos.entryPrice).toFixed(2)}.`
          : "No open position right now.",
      });
    }

    /* ───────── why_trade: context-aware + prefers Trade.reason (future) + falls back to AI explanation ───────── */
    if (intent === "why_trade") {
      const tradedTickers = Array.from(new Set(tradesInRange.map(t => t.ticker.toUpperCase())));

      let ticker = extractTicker(msg);
      if (ticker && !tradedTickers.includes(ticker.toUpperCase())) ticker = null;

      if (!ticker) {
        if (tradedTickers.length === 1) {
          ticker = tradedTickers[0];
        } else if (tradedTickers.length > 1) {
          return NextResponse.json({
            reply:
              `I saw multiple tickers ${label}: ${tradedTickers.join(", ")}. ` +
              `Which one do you mean? (e.g., “Why did we take ${tradedTickers[0]}?”)`,
          });
        } else {
          return NextResponse.json({ reply: `No trades ${label}, so there’s nothing to explain.` });
        }
      }

      const relevant = tradesInRange.filter(t => t.ticker.toUpperCase() === ticker!.toUpperCase());
      if (!relevant.length) return NextResponse.json({ reply: `I didn’t see a ${ticker!.toUpperCase()} trade ${label}.` });

      const first = relevant[0];
      const whenET = toETParts(new Date(first.at));
      const side = String(first.side).toUpperCase();
      const priceStr = asNumber(first.price).toFixed(2);

      // 1) Prefer per-trade reason if you add it later (kept commented so this compiles today)
      let tradeReason: string | null = null as any;
      try {
        // Uncomment after adding `reason String?` to Trade:
        // const specific = await prisma.trade.findFirst({
        //   where: { id: first.id },
        //   select: { reason: true },
        // });
        // tradeReason = (specific?.reason || "").trim() || null;
      } catch {}

      // 2) Fallback: use the AI pick explanation saved in Recommendation
      let exp: string | null = null;
      if (!tradeReason) {
        const rec = await fetchLatestRecommendationForTickerInWindow(ticker!, startUTC, endUTC);
        exp = (rec?.explanation || "").trim() || null;
      }

      const header =
        `We ${side === "BUY" ? "entered" : "executed a " + side} ${ticker!.toUpperCase()} ` +
        `${label} around $${priceStr} (${whenET.ymd} ${whenET.hms} ET).`;

      if (tradeReason) return NextResponse.json({ reply: `${header}\nReason: ${tradeReason}` });
      if (exp) return NextResponse.json({ reply: `${header}\nReason (from the AI pick): ${exp}` });

      return NextResponse.json({
        reply:
          `${header} To show a specific trade thesis here, add a nullable 'reason' column to Trade and save a short note on entry.`,
      });
    }

    if (intent === "why_pick") {
      const ticker = extractTicker(msg);
      if (!ticker) {
        return NextResponse.json({
          reply: "Tell me the ticker (e.g., “Why did the AI pick ABCD today?”). I’ll pull the saved explanation.",
        });
      }
      const rec = await fetchLatestRecommendationForTickerInWindow(ticker, startUTC, endUTC);
      if (rec) {
        const whenET = toETParts(new Date(rec.at));
        const price = asNumber(rec.price).toFixed(2);
        const exp = (rec.explanation || "").trim();
        if (exp) {
          return NextResponse.json({
            reply: `AI picked ${ticker.toUpperCase()} ${label} around $${price} (${whenET.ymd} ${whenET.hms} ET). Reason: ${exp}`,
          });
        }
        return NextResponse.json({
          reply:
            `AI picked ${ticker.toUpperCase()} ${label} around $${price} (${whenET.ymd} ${whenET.hms} ET). ` +
            `No explanation was saved for this pick.`,
        });
      }
      return NextResponse.json({
        reply:
          `I couldn’t find a saved recommendation for ${ticker.toUpperCase()} ${label}. ` +
          `Make sure your /api/recommendation route is called when the AI selects a ticker.`,
      });
    }

    // Default status
    const realized = realizedFIFO(tradesInRange);
    const traded = summarizeTrades(tradesInRange);
    const parts: string[] = [];

    if (openPos?.open) {
      parts.push(`Currently holding ${openPos.shares} ${openPos.ticker} @ $${asNumber(openPos.entryPrice).toFixed(2)}.`);
    } else {
      parts.push("No open position right now.");
    }
    if (traded === "No trades in that range.") parts.push(`No trades ${label}.`);
    else parts.push(`Trades ${label}: ${traded}.`);
    if (tradesInRange.length) parts.push(`Realized P&L ${label}: ${money(realized)}.`);

    return NextResponse.json({ reply: parts.join(" ") });
  } catch (e: any) {
    return NextResponse.json(
      { reply: `Sorry—couldn't process that. ${e?.message || "Unknown error."}` },
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
  const nowUTC = new Date();
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
  return NextResponse.json({ nowET: toETParts(nowUTC), last: rows });
}
