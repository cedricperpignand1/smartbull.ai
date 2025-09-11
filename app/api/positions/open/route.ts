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
    const row: any = await prisma.position.findFirst({
      where: { open: true },
      orderBy: { id: "desc" },
    });

    if (debug) {
      // NOTE: only logs server-side; helpful in Vercel logs/dev console
      console.log("[/api/positions/open] raw row:", row);
    }

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

    // Validate: when open === true, we MUST have a ticker and entryPrice.
    const problems: string[] = [];
    if (!ticker) problems.push("missing ticker");
    if (entryPx == null) problems.push("missing entryPrice");
    if (enteredAt == null) problems.push("missing entryAt");
    if (sharesNum == null || sharesNum <= 0) problems.push("missing/invalid shares");

    if (problems.length > 0) {
      const msg = `Open position row is malformed: ${problems.join(", ")}`;
      if (debug) console.error("[/api/positions/open]", msg, { row });
      // Return 500 so the frontend fetch throws and you notice it.
      return NextResponse.json(
        { ...EMPTY, error: msg },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const payload: PositionWire = {
      open: true,
      ticker,
      shares: Math.floor(sharesNum!),
      entryPrice: entryPx,
      entryAt: enteredAt,
      stopLoss: sl,
      takeProfit: tp,
    };

    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    const msg = e?.message || "failed to load position";
    if (debug) console.error("[/api/positions/open] ERROR", msg);
    // Use 500 here so your frontend sees an error (fetchJSON throws) instead of quietly “open: false”
    return NextResponse.json(
      { ...EMPTY, error: msg },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
