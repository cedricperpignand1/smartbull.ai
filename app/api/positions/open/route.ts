// app/api/positions/open/route.ts
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
  entryAt: string | null;    // ISO
  stopLoss: number | null;
  takeProfit: number | null;
  error?: string;
};

// safe number → number|null
const num = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// safe ISO date → string|null
const iso = (d: any): string | null => {
  const t = d instanceof Date ? d : (d ? new Date(d) : null);
  return t && !isNaN(t.getTime()) ? t.toISOString() : null;
};

const EMPTY: PositionWire = {
  open: false,
  ticker: null,
  shares: null,
  entryPrice: null,
  entryAt: null,
  stopLoss: null,
  takeProfit: null,
};

export async function GET() {
  try {
    const row: any = await prisma.position.findFirst({
      where: { open: true },
      orderBy: { id: "desc" },
    });

    if (!row) {
      return NextResponse.json(EMPTY, { headers: { "Cache-Control": "no-store" } });
    }

    // map possible column aliases from your schema
    const tickerRaw = row.ticker ?? row.symbol ?? null;
    const entryPx   = num(row.entryPrice ?? row.avgEntry);
    const sharesNum = num(row.shares ?? row.qty);
    const sl        = num(row.stopLoss ?? row.stop_price);
    const tp        = num(row.takeProfit ?? row.target_price);

    const payload: PositionWire = {
      open: true,
      ticker: typeof tickerRaw === "string" ? tickerRaw.toUpperCase() : null,
      shares: Number.isFinite(sharesNum ?? NaN) ? Math.floor(sharesNum!) : null,
      entryPrice: entryPx,
      entryAt: iso(row.entryAt ?? row.enteredAt ?? row.createdAt),
      stopLoss: sl,
      takeProfit: tp,
    };

    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    const errPayload: PositionWire = { ...EMPTY, error: e?.message || "failed to load position" };
    return NextResponse.json(errPayload, { headers: { "Cache-Control": "no-store" }, status: 200 });
  }
}
