// app/api/l2/pressure/route.ts
import { NextResponse } from "next/server";
import { pressure as calcPressure } from "../../../../lib/l2Store";
import { startL2SubscriptionLoop } from "../../../../lib/databentoBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Start/ensure the background subscription reconciler is running.
// Safe to call multiple times; internally it guards against duplicates.
startL2SubscriptionLoop(1500);

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const raw = (url.searchParams.get("symbols") || "").trim();
    if (!raw) {
      return NextResponse.json(
        { ok: false, error: "Missing ?symbols=SYM1,SYM2" },
        { status: 400 }
      );
    }

    // normalize, unique, at most 2
    const symbols = Array.from(
      new Set(
        raw
          .split(",")
          .map(s => s.trim().toUpperCase())
          .filter(Boolean)
      )
    ).slice(0, 2);

    const results = symbols.map(sym => {
      const res = calcPressure(sym); // returns whatever your buyPressure() returns
      const score = res && typeof res === "object" ? (res as any).score ?? null : null;
      return {
        symbol: sym,
        score,
        detail: res ?? null, // keep the full breakdown so you can inspect
      };
    });

    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "failed_to_compute" },
      { status: 500 }
    );
  }
}
