// app/api/vwap-breadth/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { getBars1m } from "@/lib/alpaca";
import { isMarketHoursET, nowET, yyyyMmDdET } from "@/lib/market";

/* ───────────────────────── In-memory cache (60s) ───────────────────────── */
type CacheEntry = { ts: number; payload: any };
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 60 * 1000;

/* ─────────────────────────────── Types ─────────────────────────────── */
type Bar1m = {
  t: string; // ISO string
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

/* ───────────────────────────── Helpers ───────────────────────────── */
function sortAndKey(tickers: string[]) {
  return tickers
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 8)
    .sort()
    .join(",");
}

function typicalPrice(b: Bar1m) {
  return (b.h + b.l + b.c) / 3;
}

function computeIntradayVWAP(bars: Bar1m[]) {
  if (!bars?.length) return null;
  let pv = 0;
  let vv = 0;
  for (const b of bars) {
    const tp = typicalPrice(b);
    if (!Number.isFinite(tp) || !Number.isFinite(b.v)) continue;
    pv += tp * b.v;
    vv += b.v;
  }
  if (vv <= 0) return null;
  return pv / vv;
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
    const tickers = rawTickers.map((s) => String(s || "")).filter(Boolean).slice(0, 8);

    if (!tickers.length) {
      return NextResponse.json({ ok: false, error: "No tickers provided" }, { status: 400 });
    }

    const key = sortAndKey(tickers);
    const nowMs = Date.now();

    // Serve from cache if fresh
    const hit = CACHE.get(key);
    if (hit && nowMs - hit.ts < TTL_MS) {
      return NextResponse.json(hit.payload, { headers: { "Cache-Control": "no-store" } });
    }

    // If market is closed, avoid API usage; return neutral payload
    if (!isMarketHoursET()) {
      const payload = {
        ok: true,
        total: 0,
        above: 0,
        below: 0,
        flat: 0,
        ratio: 0,
        marketOpen: false,
        tickers,
      };
      CACHE.set(key, { ts: nowMs, payload });
      return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
    }

    // Build start/end ISO for *today's* session in ET (9:30 → nowET)
    const now = getNowET();
    const start = new Date(now);
    start.setHours(9, 30, 0, 0); // 09:30:00 (ET assumption handled by your market helper)
    const startISO = start.toISOString();
    const endISO = now.toISOString();
    const limit = 240; // 1m bars cap

    const results = await Promise.all(
      tickers.map(async (symbol) => {
        try {
          const bars: Bar1m[] = await getBars1m(symbol, startISO, endISO, limit);
          if (!Array.isArray(bars) || !bars.length) return { symbol, ok: false };

          const vwap = computeIntradayVWAP(bars);
          const last = bars[bars.length - 1]?.c ?? null;
          if (!vwap || !last) return { symbol, ok: false };

          const above = last >= vwap * 1.0001; // small epsilon
          const below = last <= vwap * 0.9999;

          return {
            symbol,
            ok: true,
            vwap,
            last,
            state: above ? "above" : below ? "below" : "flat",
          };
        } catch {
          return { symbol, ok: false };
        }
      })
    );

    let above = 0;
    let below = 0;
    let flat = 0;
    for (const r of results) {
      if (!r?.ok) continue;
      if (r.state === "above") above += 1;
      else if (r.state === "below") below += 1;
      else flat += 1;
    }
    const total = above + below + flat;
    const ratio = total ? above / total : 0;

    const payload = {
      ok: true,
      total,
      above,
      below,
      flat,
      ratio,
      marketOpen: true,
      tickers,
      session: {
        dateET: yyyyMmDdET(), // ✅ no arguments
        startISO,
        endISO,
      },
    };

    CACHE.set(key, { ts: nowMs, payload });
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Unknown error" }, { status: 500 });
  }
}
