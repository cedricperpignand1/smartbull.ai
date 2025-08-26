// app/api/ai-chat/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/* ---------- US/Eastern helpers (no ICU required) ---------- */
// first/second Sunday helpers (UTC)
function firstSundayUTC(year: number, monthIndex: number) {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  const dow = d.getUTCDay(); // 0..6, 0 = Sunday
  const add = (7 - dow) % 7;
  return 1 + add;
}
function secondSundayUTC(year: number, monthIndex: number) {
  return firstSundayUTC(year, monthIndex) + 7;
}
// DST window for US/Eastern (based on UTC instants)
function isDST_US_Eastern(utc: Date): boolean {
  const y = utc.getUTCFullYear();
  // DST starts: second Sun in March @ 07:00 UTC (2:00 ET)
  const start = Date.UTC(y, 2, secondSundayUTC(y, 2), 7, 0, 0);
  // DST ends: first Sun in Nov @ 06:00 UTC (2:00 ET)
  const end = Date.UTC(y, 10, firstSundayUTC(y, 10), 6, 0, 0);
  const t = utc.getTime();
  return t >= start && t < end;
}
/** Returns { ymd:"YYYY-MM-DD", hms:"HH:MM:SS" } for the instant in ET */
function toETParts(utcInstant: Date) {
  const offsetMin = isDST_US_Eastern(utcInstant) ? -240 : -300; // EDT = -4h, EST = -5h
  const shifted = new Date(utcInstant.getTime() + offsetMin * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  const ss = String(shifted.getUTCSeconds()).padStart(2, "0");
  return { ymd: `${y}-${m}-${d}`, hms: `${hh}:${mm}:${ss}` };
}
function sameETDay(aUTC: Date, bUTC: Date) {
  return toETParts(aUTC).ymd === toETParts(bUTC).ymd;
}

/* ---------- Types ---------- */
type DbTrade = {
  id: number;
  side: "BUY" | "SELL";
  ticker: string;
  price: number;
  shares: number;
  createdAt: Date; // Prisma returns JS Date
};
type DbPos = {
  id: number;
  ticker: string;
  entryPrice: number;
  shares: number;
  open: boolean;
};

/* ---------- FIFO realized PnL (for today) ---------- */
type Lot = { qty: number; cost: number };
function realizedTodayFIFO(tradesAsc: DbTrade[]): number {
  const lots: Lot[] = [];
  let realized = 0;
  for (const t of tradesAsc) {
    if (t.side === "BUY") {
      lots.push({ qty: t.shares, cost: t.price });
      continue;
    }
    // SELL
    let remain = t.shares;
    while (remain > 0 && lots.length) {
      const lot = lots[0];
      const take = Math.min(lot.qty, remain);
      realized += (t.price - lot.cost) * take;
      lot.qty -= take;
      remain -= take;
      if (lot.qty === 0) lots.shift();
    }
  }
  return realized;
}

/* ---------- Intent routing ---------- */
function intentOf(q: string) {
  const m = q.toLowerCase();
  if (/(what|which).*(trade|traded|ticker).*(today)/.test(m)) return "what_traded_today";
  if (/((did|do).*(make|made).*(money|profit)|p&?l|green|red).*(today)/.test(m)) return "pnl_today";
  if (/(are|am|you).*(in|holding).*(position)|open position/.test(m)) return "in_position";
  return "status";
}

export async function POST(req: Request) {
  try {
    const { message } = await req.json();

    // Grab plenty of history so "today" is present
    const [tradesDesc, openPos] = await Promise.all([
      prisma.trade.findMany({ orderBy: { id: "desc" }, take: 1000 }) as unknown as Promise<DbTrade[]>,
      prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } }) as unknown as Promise<DbPos | null>,
    ]);

    const nowUTC = new Date();
    const todayYMD = toETParts(nowUTC).ymd;

    // Normalize trades -> ensure Date & filter to today's ET date
    const tradesTodayAsc = tradesDesc
      .filter((t) => t?.createdAt)
      .filter((t) => sameETDay(new Date(t.createdAt), nowUTC))
      .sort((a, b) => a.id - b.id);

    const uniqueTickersToday = Array.from(new Set(tradesTodayAsc.map((t) => t.ticker)));
    const todayTicker = uniqueTickersToday[0] ?? null;
    const todayRealized = realizedTodayFIFO(tradesTodayAsc);

    const intent = intentOf(String(message || ""));
    const money = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;

    if (intent === "what_traded_today") {
      return NextResponse.json({
        reply: todayTicker ? `I traded ${todayTicker} today.` : "No trades yet today.",
      });
    }

    if (intent === "pnl_today") {
      return NextResponse.json({
        reply: todayTicker
          ? `Realized P&L today on ${todayTicker}: ${money(todayRealized)}.`
          : "No trades yet today, so P&L is $0.00.",
      });
    }

    if (intent === "in_position") {
      return NextResponse.json({
        reply: openPos?.open
          ? `Yes. Holding ${openPos.shares} ${openPos.ticker} @ $${Number(openPos.entryPrice).toFixed(2)}.`
          : "No open position right now.",
      });
    }

    // Default concise status
    const parts: string[] = [];
    parts.push(
      openPos?.open
        ? `Open: ${openPos.shares} ${openPos.ticker} @ $${Number(openPos.entryPrice).toFixed(2)}.`
        : "No open position."
    );
    parts.push(todayTicker ? `Today’s ticker: ${todayTicker}.` : "No trades yet today.");
    if (todayTicker) parts.push(`Today’s realized P&L: ${money(todayRealized)}.`);
    return NextResponse.json({ reply: parts.join(" ") });
  } catch (e: any) {
    return NextResponse.json(
      { reply: `Sorry—couldn't read today's trades. ${e?.message || "Unknown error."}` },
      { status: 200 }
    );
  }
}

/* Optional: quick debug – shows how the API sees your last 8 trades in ET */
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("debug") !== "1") {
    return NextResponse.json({ reply: "Send a POST with { message }." });
  }
  const trades = (await prisma.trade.findMany({ orderBy: { id: "desc" }, take: 8 })) as unknown as DbTrade[];
  const nowUTC = new Date();
  const today = toETParts(nowUTC).ymd;
  const rows = trades.map((t) => {
    const et = toETParts(new Date(t.createdAt));
    return {
      id: t.id,
      ticker: t.ticker,
      side: t.side,
      price: t.price,
      shares: t.shares,
      createdAt_utc: new Date(t.createdAt).toISOString(),
      createdAt_et: `${et.ymd} ${et.hms}`,
      isTodayET: et.ymd === today,
    };
  });
  return NextResponse.json({ todayET: today, last: rows });
}
