// app/api/bot/reset/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const START_CASH = 4000;
// You can override via env; defaults to 9340 as requested.
const RESET_KEY = process.env.RESET_KEY || "9340";

async function doReset() {
  const [trades, positions, recs] = await prisma.$transaction([
    prisma.trade.deleteMany({}),
    prisma.position.deleteMany({}),
    prisma.recommendation.deleteMany({}),
  ]);

  const state = await prisma.botState.upsert({
    where: { id: 1 },
    update: { cash: START_CASH, pnl: 0, equity: START_CASH, lastRunDay: null },
    create: { id: 1, cash: START_CASH, pnl: 0, equity: START_CASH },
  });

  return { trades: trades.count, positions: positions.count, recommendations: recs.count, state };
}

export async function POST(req: Request) {
  try {
    // Accept key from header or JSON body
    const headerKey = req.headers.get("x-reset-key");
    let bodyKey: string | null = null;
    try {
      const body = await req.json().catch(() => null);
      if (body && typeof body.key === "string") bodyKey = body.key;
    } catch {}

    const provided = headerKey || bodyKey || "";
    if (provided !== RESET_KEY) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const deleted = await doReset();
    return NextResponse.json({ ok: true, deleted });
  } catch (e: any) {
    console.error("reset error:", e);
    return NextResponse.json({ ok: false, error: e?.message || "reset_failed" }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: false, error: "Use POST" }, { status: 405 });
}
