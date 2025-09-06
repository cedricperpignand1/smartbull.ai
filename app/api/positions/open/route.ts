export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type PositionWire = {
  open: boolean;
  ticker: string | null;
  shares: number | null;
  entryPrice: number | null;
  entryAt: string | null; // ISO
  stopLoss: number | null;
  takeProfit: number | null;
  error?: string;
};

export async function GET() {
  try {
    const row: any = await prisma.position.findFirst({
      where: { open: true },
      orderBy: { id: "desc" },
    });

    if (!row) {
      return NextResponse.json({
        open: false,
        ticker: null,
        shares: null,
        entryPrice: null,
        entryAt: null,
        stopLoss: null,
        takeProfit: null,
      } satisfies PositionWire);
    }

    const stopLoss = row.stopLoss ?? row.stop_price ?? null;
    const takeProfit = row.takeProfit ?? row.target_price ?? null;

    const payload: PositionWire = {
      open: true,
      ticker: row.ticker ?? row.symbol ?? null,
      shares: Number(row.shares ?? row.qty ?? 0) || null,
      entryPrice:
        row.entryPrice != null
          ? Number(row.entryPrice)
          : row.avgEntry != null
          ? Number(row.avgEntry)
          : null,
      entryAt: row.entryAt ? new Date(row.entryAt).toISOString() : null,
      stopLoss: stopLoss != null ? Number(stopLoss) : null,
      takeProfit: takeProfit != null ? Number(takeProfit) : null,
    };

    return NextResponse.json(payload);
  } catch (e: any) {
    return NextResponse.json({
      open: false,
      ticker: null,
      shares: null,
      entryPrice: null,
      entryAt: null,
      stopLoss: null,
      takeProfit: null,
      error: e?.message || "failed to load position",
    } satisfies PositionWire);
  }
}
