// app/api/trades/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function cutoffFromDays(daysParam: unknown) {
  const n = Number(daysParam);
  const days = Number.isFinite(n) ? n : 7;
  const clamped = Math.max(1, Math.min(90, Math.floor(days)));
  return new Date(Date.now() - clamped * 24 * 60 * 60 * 1000);
}

async function listTrades(days: number, limit: number) {
  const cutoff = cutoffFromDays(days);

  const trades = await prisma.trade.findMany({
    where: {
      OR: [
        { filledAt: { gte: cutoff } },
        { at: { gte: cutoff } },
      ],
    },
    orderBy: [
      { filledAt: "desc" },
      { at: "desc" },
      { id: "desc" },
    ],
    take: Math.max(1, Math.min(5000, limit || 2000)),
  });

  const openPos = await prisma.position.findFirst({
    where: { open: true },
    orderBy: { id: "desc" },
  });

  return { trades, openPos };
}

// GET /api/trades?days=7&limit=2000
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const days = Number(url.searchParams.get("days") ?? "7");
    const limit = Number(url.searchParams.get("limit") ?? "2000");
    const data = await listTrades(days, limit);
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json(
      { errorMessage: e?.message || "Failed to load trades" },
      { status: 500 }
    );
  }
}

// Mirror GET for POST callers
export async function POST(req: Request) {
  return GET(req);
}

export async function HEAD() {
  return new Response(null, { status: 200 });
}
