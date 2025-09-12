// app/api/trades/today/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/** Get current date in ET */
function nowET() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}
/** Start/end of *today* in ET, returned as UTC Dates for DB filtering */
function todayEtRangeAsUTC() {
  const etNow = nowET();
  const y = etNow.getFullYear();
  const m = etNow.getMonth(); // 0-11
  const d = etNow.getDate();

  // How many minutes ET is offset from UTC right now (accounts for DST)
  const offsetMin = Math.round((etNow.getTime() - new Date().getTime()) / 60000);

  const startEtMidnightUTC = new Date(Date.UTC(y, m, d, 0, 0, 0) - offsetMin * 60000);
  const endEtMidnightUTC = new Date(startEtMidnightUTC.getTime() + 24 * 60 * 60 * 1000);
  return { startUTC: startEtMidnightUTC, endUTC: endEtMidnightUTC };
}

type TradeWire = {
  side: "BUY" | "SELL" | string;
  ticker: string;
  price: number;
  shares: number;
  at: string; // ISO
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") || searchParams.get("ticker") || "").toUpperCase().trim();

  const { startUTC, endUTC } = todayEtRangeAsUTC();

  try {
    // Support either prisma.trade or prisma.trades
    const models: any[] = [];
    if ((prisma as any).trade) models.push((prisma as any).trade);
    if ((prisma as any).trades) models.push((prisma as any).trades);
    if (!models.length) {
      return NextResponse.json({ trades: [], error: "No prisma model: trade/trades" }, { status: 200 });
    }

    // Try each model until one returns
    let rows: any[] = [];
    for (const model of models) {
      rows = await model.findMany({
        where: {
          createdAt: { gte: startUTC, lt: endUTC },
          ...(symbol ? { OR: [{ ticker: symbol }, { symbol }] } : {}),
        },
        orderBy: { createdAt: "asc" },
      });
      if (rows?.length >= 0) break;
    }

    // Normalize to the shape the chart expects
    const trades: TradeWire[] = (rows || []).map((r: any) => ({
      side: String(r.side ?? r.type ?? "").toUpperCase(),
      ticker: String(r.ticker ?? r.symbol ?? "").toUpperCase(),
      price: Number(r.price ?? r.fill_price ?? r.avgPrice ?? r.avg_price ?? 0),
      shares: Number(r.shares ?? r.qty ?? r.quantity ?? 0),
      at: new Date(r.at ?? r.time ?? r.createdAt ?? r.filledAt ?? r.executedAt ?? r.updatedAt ?? Date.now()).toISOString(),
    }));

    // If a symbol was passed, filter client *and* server side just to be safe
    const out = symbol ? trades.filter(t => t.ticker === symbol) : trades;

    return NextResponse.json({ trades: out }, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    return NextResponse.json(
      { trades: [], error: e?.message || "failed to load today's trades" },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }
}
