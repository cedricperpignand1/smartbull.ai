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
  entryAt: string | null; // ISO
  stopLoss: number | null;
  takeProfit: number | null;
  error?: string;
};

// ---- helpers
const num = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
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

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const debug = searchParams.get("debug") === "1";

  try {
    // some users name the model "positions" instead of "position"
    const models: any[] = [];
    if ((prisma as any).position) models.push((prisma as any).position);
    if ((prisma as any).positions) models.push((prisma as any).positions);

    if (models.length === 0) {
      const msg = "Prisma model not found: position/positions";
      if (debug) console.error("[/api/positions/open]", msg);
      return NextResponse.json({ ...EMPTY, error: msg }, { status: 200, headers: { "Cache-Control": "no-store" } });
    }

    // search the most recent open position on whichever model exists
    let row: any = null;
    for (const model of models) {
      row = await model.findFirst({
        where: { open: true },
        orderBy: { id: "desc" },
      });
      if (row) break;
    }

    if (debug) console.log("[/api/positions/open] raw row:", row);

    // No open position → return EMPTY (200) so the UI shows the placeholder.
    if (!row) {
      return NextResponse.json(EMPTY, { headers: { "Cache-Control": "no-store" } });
    }

    // Map possible aliases from your schema
    const tickerRaw = row.ticker ?? row.symbol ?? null;
    const entryPx = num(row.entryPrice ?? row.avgEntry);
    const sharesNum = num(row.shares ?? row.qty);
    const sl = num(row.stopLoss ?? row.stop_price);
    const tp = num(row.takeProfit ?? row.target_price);
    const enteredAt = iso(row.entryAt ?? row.enteredAt ?? row.createdAt);

    const ticker =
      typeof tickerRaw === "string" && tickerRaw.trim().length > 0
        ? tickerRaw.trim().toUpperCase()
        : null;

    // Be tolerant: only require ticker + entryPrice to consider "open"
    const problems: string[] = [];
    if (!ticker) problems.push("missing ticker");
    if (entryPx == null) problems.push("missing entryPrice");

    if (problems.length > 0) {
      const msg = `Open position row looks incomplete: ${problems.join(", ")}`;
      if (debug) console.warn("[/api/positions/open]", msg, { row });
      // Do NOT 500 — return EMPTY with error so UI can still fallback/sticky
      return NextResponse.json({ ...EMPTY, error: msg }, { headers: { "Cache-Control": "no-store" } });
    }

    const payload: PositionWire = {
      open: true,
      ticker,
      shares: sharesNum != null ? Math.floor(sharesNum) : null,
      entryPrice: entryPx,
      entryAt: enteredAt, // may be null; chart handles missing marker
      stopLoss: sl,
      takeProfit: tp,
    };

    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    const msg = e?.message || "failed to load position";
    if (debug) console.error("[/api/positions/open] ERROR", msg);
    // Return a *200* with EMPTY so the UI keeps working (and shows placeholder/fallback).
    return NextResponse.json({ ...EMPTY, error: msg }, { headers: { "Cache-Control": "no-store" } });
  }
}
