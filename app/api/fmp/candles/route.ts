// app/api/fmp/candles/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const FMP_API_KEY = process.env.FMP_API_KEY; // ❗ never ship a default fallback

// Allowed FMP intervals. Add more if you use them.
const ALLOWED = new Set([
  "1min",
  "5min",
  "15min",
  "30min",
  "1hour",
  "4hour"
]);

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const symbolRaw = searchParams.get("symbol");
    let interval = (searchParams.get("interval") || "1min").toLowerCase();
    const limit = Math.max(1, Math.min(1000, Number(searchParams.get("limit") || 240)));

    if (!symbolRaw) {
      return NextResponse.json({ error: "symbol required" }, { status: 400 });
    }
    if (!ALLOWED.has(interval)) {
      interval = "1min";
    }
    if (!FMP_API_KEY) {
      console.error("[/api/fmp/candles] Missing FMP_API_KEY");
      return NextResponse.json({ error: "Server not configured" }, { status: 500 });
    }

    const symbol = encodeURIComponent(symbolRaw.trim().toUpperCase());
    const url = `https://financialmodelingprep.com/api/v3/historical-chart/${interval}/${symbol}?apikey=${FMP_API_KEY}`;

    // Add an 8s timeout so hung upstream calls don’t pile up
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);

    const r = await fetch(url, { cache: "no-store", signal: ctrl.signal }).catch((e) => {
      throw new Error(`Fetch failed: ${e?.message || e}`);
    });

    clearTimeout(t);

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("[/api/fmp/candles] Upstream error", r.status, text);
      return NextResponse.json({ error: `FMP ${r.status}` }, { status: r.status });
    }

    const raw = await r.json();

    // FMP returns newest-first. We want the last `limit` candles in *chronological* order.
    const arr = Array.isArray(raw) ? raw : [];
    // Get the most recent `limit`, then reverse to oldest -> newest for easier calculations
    const lastN = arr.slice(0, limit).reverse();

    // Normalize fields to numbers
    const candles = lastN.map((c: any) => ({
      date: String(c?.date ?? ""),
      open: Number(c?.open ?? 0),
      high: Number(c?.high ?? 0),
      low: Number(c?.low ?? 0),
      close: Number(c?.close ?? 0),
      volume: Number(c?.volume ?? 0),
    }));

    return NextResponse.json({ candles });
  } catch (err: any) {
    console.error("[/api/fmp/candles] ERROR:", err?.message || err);
    const msg =
      err?.name === "AbortError" ? "Upstream timeout" : err?.message || "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
