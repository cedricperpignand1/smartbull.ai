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
function cumulativeVolume(bars: Bar1m[]) {
  let sum = 0;
  for (const b of bars) sum += Number(b?.v || 0);
  return sum;
}
/** Works whether `nowET` is a function or a value */
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

    // Build session window (today 9:30 → now if open, else 16:00)
    const open = isMarketHoursET();
    const now = getNowET();
    const start = new Date(now);
    start.setHours(9, 30, 0, 0);
    const end = new Date(now);
    if (!open) end.setHours(16, 0, 0, 0);

    const startISO = start.toISOString();
    const endISO = end.toISOString();
    const limit = 420; // enough to cover a full session if your helper caps by limit

    const debug: any = { dateET: yyyyMmDdET(), marketOpen: open, startISO, endISO, checks: [] };

    // Fetch and compute
    const results = await Promise.all(
      tickers.map(async (symbol) => {
        try {
          const bars: Bar1m[] = await getBars1m(symbol, startISO, endISO, limit);
          const count = Array.isArray(bars) ? bars.length : 0;
          if (!count) {
            debug.checks.push({ symbol, reason: "no-bars" });
            return { symbol, ok: false };
          }

          // Filter by cumulative session volume >= 9,000,000
          const cumVol = cumulativeVolume(bars);
          if (cumVol < 9_000_000) {
            debug.checks.push({ symbol, reason: "low-cum-vol", cumVol });
            return { symbol, ok: false };
          }

          const vwap = computeIntradayVWAP(bars);
          const last = bars[bars.length - 1]?.c ?? null;
          if (!vwap || !last) {
            debug.checks.push({ symbol, reason: "no-vwap-or-last", cumVol, barCount: count });
            return { symbol, ok: false };
          }

          const above = last >= vwap * 1.0001;
          const below = last <= vwap * 0.9999;
          const state = above ? "above" : below ? "below" : "flat";
          debug.checks.push({ symbol, cumVol, barCount: count, state });

          return { symbol, ok: true, state };
        } catch (e: any) {
          debug.checks.push({ symbol, error: String(e?.message || e) });
          return { symbol, ok: false };
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
      skipped,               // low-volume or failed symbols
      ratio,
      marketOpen: open,
      tickers,
      debug,                 // keep for now—super helpful to verify filtering
    };

    CACHE.set(key, { ts: nowMs, payload });
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Unknown error" }, { status: 500 });
  }
}
