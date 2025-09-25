import { NextResponse } from "next/server";

// If you already have these helpers, prefer them.
// Otherwise this route will try a very-low-cost FMP fetch.
import { fmpQuoteCached } from "../../../../lib/fmpCached"; // <- keep this path consistent with your project

// Simple in-memory cache (per server instance)
let CACHE: { data: any; ts: number } | null = null;
const TTL_MS = 15_000; // 15s cache to minimize API hits

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Tone = "bull" | "bear" | "neutral";

function toneFromPct(pct: number, bull = 0.5, bear = -0.5): Tone {
  if (pct >= bull) return "bull";
  if (pct <= bear) return "bear";
  return "neutral";
}

export async function GET() {
  // Serve from cache
  const now = Date.now();
  if (CACHE && now - CACHE.ts < TTL_MS) {
    return NextResponse.json(CACHE.data);
  }

  try {
    // Prefer SPY; fallback to ^GSPC if needed.
    let quote: any = await fmpQuoteCached?.("SPY");
    if (!quote || typeof quote !== "object") {
      // Optional fallback (comment out if you only want SPY)
      try { quote = await fmpQuoteCached("^GSPC"); } catch {}
    }

    // Normalize numbers
    const price = Number(quote?.price ?? quote?.c ?? NaN);
    const prevClose = Number(
      quote?.previousClose ?? quote?.pc ?? quote?.prevClose ?? NaN
    );
    let pct = Number(quote?.changesPercentage ?? quote?.dp ?? NaN);

    // If % not provided, derive from price / prevClose
    if (!Number.isFinite(pct) && Number.isFinite(price) && Number.isFinite(prevClose) && prevClose > 0) {
      pct = ((price - prevClose) / prevClose) * 100;
    }

    // If still missing, return neutral
    const pctSafe = Number.isFinite(pct) ? pct : 0;

    const data = {
      ok: true,
      symbol: "SPY",
      pct: pctSafe,                 // percent move today
      tone: toneFromPct(pctSafe),   // bull | bear | neutral (±0.5% default)
      ts: new Date().toISOString(),
    };

    CACHE = { data, ts: now };
    return NextResponse.json(data);
  } catch (e: any) {
    const data = { ok: false, error: e?.message || "failed", tone: "neutral", pct: 0, ts: new Date().toISOString() };
    CACHE = { data, ts: now }; // even cache an error briefly to avoid hammering
    return NextResponse.json(data, { status: 200 });
  }
}
