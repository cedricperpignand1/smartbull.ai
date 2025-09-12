// app/api/trades/today/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type TradeWire = {
  side: "BUY" | "SELL" | string;
  ticker: string;
  price: number;
  shares: number;
  at: string; // ISO
};

function toMs(x: any): number | null {
  if (x == null) return null;
  if (typeof x === "number") {
    // accept sec or ms
    return x < 1e12 ? Math.round(x * 1000) : Math.round(x);
  }
  const d = new Date(x);
  if (!isNaN(d.getTime())) return d.getTime();
  const n = Number(x);
  return Number.isFinite(n) ? (n < 1e12 ? Math.round(n * 1000) : Math.round(n)) : null;
}

function etDayKey(ms: number) {
  const d = new Date(new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York" }));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = (searchParams.get("symbol") || searchParams.get("ticker") || "")
      .toUpperCase()
      .trim();
    const limit = Math.max(50, Math.min(2000, Number(searchParams.get("limit") || "1000")));

    // Support either prisma.trade or prisma.trades
    const model: any = (prisma as any).trade ?? (prisma as any).trades;
    if (!model) {
      return NextResponse.json({ trades: [], error: "No prisma model trade/trades" }, { status: 200 });
    }

    // IMPORTANT: do NOT time-filter in SQL (schema/timezone vary). Just take latest and filter in JS.
    const rows: any[] = await model.findMany({
      orderBy: { id: "desc" }, // stable/safe
      take: limit,
    });

    const todayKey = etDayKey(Date.now());

    const normalized: (TradeWire & { __ymd: string })[] = (rows || [])
      .map((r: any) => {
        const ts =
          toMs(r.filledAt) ??
          toMs(r.at) ??
          toMs(r.time) ??
          toMs(r.createdAt) ??
          toMs(r.executedAt) ??
          toMs(r.updatedAt) ??
          Date.now();

        const price =
          Number(r.price ?? r.fill_price ?? r.filledPrice ?? r.avgPrice ?? r.avg_price ?? 0);

        const shares = Number(r.shares ?? r.qty ?? r.quantity ?? 0);

        const ticker = String(r.ticker ?? r.symbol ?? "").toUpperCase();

        return {
          side: String(r.side ?? r.type ?? "").toUpperCase(),
          ticker,
          price,
          shares,
          at: new Date(ts).toISOString(),
          __ymd: etDayKey(ts),
        };
      })
      .filter((t) => t.ticker && Number.isFinite(t.price) && t.shares !== 0);

    const todays = normalized.filter(
      (t) => t.__ymd === todayKey && (!symbol || t.ticker === symbol)
    );

    return NextResponse.json(
      { trades: todays },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { trades: [], error: e?.message || "failed to load today's trades" },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }
}
