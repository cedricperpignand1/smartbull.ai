// app/api/vwap-breadth/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { getBars1m } from "@/lib/alpaca";
import { isMarketHoursET, nowET, yyyyMmDdET } from "@/lib/market";

type Bar1m = { t: string; o: number; h: number; l: number; c: number; v: number };
type CacheEntry = { ts: number; payload: any };
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

function typicalPrice(b: Bar1m) { return (b.h + b.l + b.c) / 3; }
function computeIntradayVWAP(bars: Bar1m[]) {
  if (!bars?.length) return null;
  let pv = 0, vv = 0;
  for (const b of bars) { const tp = typicalPrice(b); if (!Number.isFinite(tp) || !Number.isFinite(b.v)) continue; pv += tp * b.v; vv += b.v; }
  return vv > 0 ? pv / vv : null;
}

function getNow(): Date {
  const anyNow: any = nowET as any;
  const d = typeof anyNow === "function" ? anyNow() : anyNow;
  return d instanceof Date ? d : new Date(d);
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const tickers: string[] = Array.isArray(body?.tickers) ? body.tickers.map((s: any) => String(s || "").toUpperCase()).filter(Boolean) : [];
    if (!tickers.length) return NextResponse.json({ ok: false, error: "No tickers provided" }, { status: 400 });

    const key = tickers.slice().sort().join(",");
    const nowMs = Date.now();
    const hit = CACHE.get(key);
    if (hit && nowMs - hit.ts < TTL_MS) return NextResponse.json(hit.payload, { headers: { "Cache-Control": "no-store" } });

    // Today 9:30 ET → now (if open) else 16:00 ET
    const open = isMarketHoursET();
    const now = getNow();
    const start = new Date(now); start.setHours(9, 30, 0, 0);
    const end = new Date(now); if (!open) end.setHours(16, 0, 0, 0);
    const startISO = start.toISOString();
    const endISO = end.toISOString();
    const limit = 420;

    const results = await Promise.all(
      tickers.map(async (symbol) => {
        try {
          const bars: Bar1m[] = await getBars1m(symbol, startISO, endISO, limit);
          if (!Array.isArray(bars) || !bars.length) return { ok: false };
          const vwap = computeIntradayVWAP(bars);
          const last = bars[bars.length - 1]?.c ?? null;
          if (!vwap || !last) return { ok: false };
          const above = last >= vwap * 1.0001;
          const below = last <= vwap * 0.9999;
          return { ok: true, state: above ? "above" : below ? "below" : "flat" };
        } catch { return { ok: false }; }
      })
    );

    let above = 0, below = 0, flat = 0;
    for (const r of results) {
      if (!r.ok) continue;
      if (r.state === "above") above++;
      else if (r.state === "below") below++;
      else flat++;
    }
    const total = above + below + flat;
    const ratio = total ? above / total : 0;

    const payload = { ok: true, total, above, below, flat, ratio, marketOpen: open, tickers, session: { dateET: yyyyMmDdET(), startISO, endISO } };
    CACHE.set(key, { ts: nowMs, payload });
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Unknown error" }, { status: 500 });
  }
}
