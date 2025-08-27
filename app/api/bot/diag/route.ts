// app/api/bot/diag/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isWeekdayET, isMarketHoursET, nowET, yyyyMmDdET } from "@/lib/market";

type SnapStock = { ticker: string; price?: number | null };

function getBaseUrl(req: Request) {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = (req.headers.get("x-forwarded-proto") || "http").split(",")[0].trim();
  const host  = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

async function getSnapshot(baseUrl: string) {
  try {
    const r = await fetch(`${baseUrl}/api/stocks/snapshot`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    const stocks = Array.isArray(j?.stocks) ? j.stocks : [];
    return { stocks, updatedAt: j?.updatedAt || new Date().toISOString() };
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  try {
    const today = yyyyMmDdET();

    // Ensure state exists
    const state =
      (await prisma.botState.findUnique({ where: { id: 1 } })) ||
      (await prisma.botState.create({ data: { id: 1, cash: 4000, pnl: 0, equity: 4000 } }));

    const openPos = await prisma.position.findFirst({
      where: { open: true },
      orderBy: { id: "desc" },
    });

    const lastRec = await prisma.recommendation.findFirst({ orderBy: { id: "desc" } });

    const base = getBaseUrl(req);
    const snapshot = await getSnapshot(base);
    const tickers = (snapshot?.stocks || []).slice(0, 8).map((s: SnapStock) => s.ticker);

    // TS-safe access to optional DB fields (openAt/createdAt may vary by schema)
    const openedAt =
      openPos
        ? ((openPos as any).openAt ?? (openPos as any).createdAt ?? null)
        : null;

    return NextResponse.json({
      ok: true,
      serverTimeET: nowET().toISOString(),
      weekday: isWeekdayET(),
      marketOpen: isMarketHoursET(),
      today,
      state: {
        cash: Number(state.cash),
        pnl: Number(state.pnl),
        equity: Number(state.equity),
        lastRunDay: state.lastRunDay,
      },
      openPosition: openPos
        ? {
            ticker: openPos.ticker,
            entryPrice: Number(openPos.entryPrice),
            shares: Number(openPos.shares),
            openedAt,
          }
        : null,
      lastRecommendation: lastRec
        ? {
            ticker: lastRec.ticker,
            price: Number(lastRec.price),
            at: (lastRec as any).at ?? (lastRec as any).createdAt ?? null,
          }
        : null,
      snapshot: {
        updatedAt: snapshot?.updatedAt || null,
        count: snapshot?.stocks?.length || 0,
        top8: tickers,
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  return GET(req);
}
