// app/api/vwap-breadth/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { getBars1m } from "@/lib/alpaca";
import { isMarketHoursET, nowET, yyyyMmDdET } from "@/lib/market";

/* ───────────────────────── In-memory cache (60 s) ───────────────────────── */
type CacheEntry = { ts: number; payload: any };
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 60 * 1000;

/* ─────────────────────────────── Types ─────────────────────────────── */
type Bar1m = { t: string; o: number; h: number; l: number; c: number; v: number };

/* ───────────────────────────── Helpers ───────────────────────────── */
function sortAndKey(tickers: string[]) {
  return tickers
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 13)
    .sort()
    .join(",");
}

function typicalPrice(b: Bar1m) {
  return (b.h + b.l + b.c) / 3;
}
function computeIntradayVWAP(bars: Bar1m[]) {
  if (!bars?.length) return null;
  let pv = 0, vv = 0;
  for (const b of bars) {
    const tp = typicalPrice(b);
    if (!Number.isFinite(tp) || !Number.isFinite(b.v)) continue;
    pv += tp * b.v;
    vv += b.v;
  }
  return vv > 0 ? pv / vv : null;
}
function getNowET(): Date {
  const anyNow: any = nowET as any;
  const d = typeof anyNow === "function" ? anyNow() : anyNow;
  return d instanceof Date ? d : new Date(d);
}

/* ───────────────────────────── Route ───────────────────────────── */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const rawTickers: string[] = Array.isArray(body?.tickers) ? body.tickers : [];
    const tickers = rawTickers.map((s) => String(s || "")).filter(Boolean).slice(0, 13);
    if (!tickers.length)
      return NextResponse.json({ ok: false, error: "No tickers provided" }, { status: 400 });

    const key = sortAndKey(tickers);
    const nowMs = Date.now();
    const hit = CACHE.get(key);
    if (hit && nowMs - hit.ts < TTL_MS)
      return NextResponse.json(hit.payload, { headers: { "Cache-Control": "no-store" } });

    // Build session window
    const now = getNowET();
    const start = new Date(now);
    start.setHours(9, 30, 0, 0);
    const startISO = start.toISOString();
    const endISO = now.toISOString();
    const limit = 240;

    // Fetch and compute
    const results = await Promise.all(
      tickers.map(async (symbol) => {
        try {
          const bars: Bar1m[] = await getBars1m(symbol, startISO, endISO, limit);
          if (!Array.isArray(bars) || !bars.length) return { symbol, ok: false, reason: "no-bars" };

          const last = bars[bars.length - 1];
          const lastVol = last?.v ?? 0;
          // 🚫 Filter out illiquid
          if (lastVol < 9_000_000)
            return { symbol, ok: false, reason: `low-vol ${lastVol}` };

          const vwap = computeIntradayVWAP(bars);
          if (!vwap || !last?.c) return { symbol, ok: false, reason: "no-vwap-or-last" };

          const above = last.c >= vwap * 1.0001;
          const below = last.c <= vwap * 0.9999;
          return { symbol, ok: true, vwap, last: last.c, state: above ? "above" : below ? "below" : "flat" };
        } catch (e: any) {
          return { symbol, ok: false, reason: e?.message || "exception" };
        }
      })
    );

    let above = 0, below = 0, flat = 0, skipped = 0;
    for (const r of results) {
      if (!r?.ok) { skipped++; continue; }
      if (r.state === "above") above++;
      else if (r.state === "below") below++;
      else flat++;
    }
    const total = above + below + flat;
    const ratio = total ? above / total : 0;

    const payload = {
      ok: true,
      total,
      above,
      below,
      flat,
      skipped,           // ← number of low-volume/failed symbols
      ratio,
      marketOpen: isMarketHoursET(),
      tickers,
      dateET: yyyyMmDdET(),
    };

    CACHE.set(key, { ts: nowMs, payload });
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Unknown error" }, { status: 500 });
  }
}
