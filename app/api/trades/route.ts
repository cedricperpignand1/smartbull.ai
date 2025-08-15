export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

async function listTrades(limit = 50) {
  const trades = await prisma.trade.findMany({
    orderBy: { id: "desc" },
    take: limit,
  });

  const openPos = await prisma.position.findFirst({
    where: { open: true },
    orderBy: { id: "desc" },
  });

  return { trades, openPos };
}

// GET /api/trades?limit=50
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? "50")));
    const data = await listTrades(limit);
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ errorMessage: e?.message || "Failed to load trades" }, { status: 500 });
  }
}

// Mirror GET for POST to avoid 405s from callers that POST.
export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? "50")));
    const data = await listTrades(limit);
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ errorMessage: e?.message || "Failed to load trades" }, { status: 500 });
  }
}

// (optional) HEAD handler so fetch HEAD won’t 405
export async function HEAD() {
  return new Response(null, { status: 200 });
}
