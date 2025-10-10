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
type Bar1m = { t: string; o: number; h: number; l: number; c: number; v: number };

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
  let pv = 0, vv = 0;
  for (const b of bars) {
    const tp = typicalPrice(b);
    if (!Number.isFinite(tp) || !Number.isFinite(b.v)) continue;
    pv += tp * b.v;
    vv += b.v;
  }
  return vv > 0 ? pv / vv : null;
}

/** Works whether `nowET` is a function or a value */
function getNowET(): Date {
  const anyNow: any = nowET as any;
  const d = typeof anyNow === "function" ? anyNow() : anyNow;
  return d instanceof Date ? d : new Date(d);
}

/** Build a primary session window (today) and a fallback (past few days) */
function buildWindows() {
  const open = isMarketHoursET();       // boolean
  const now = getNowET();               // Date in ET context
  const todayET = yyyyMmDdET();         // string YYYY-MM-DD in ET

  // Primary: today's 9:30 → now (if open) else 16:00
  const start = new Date(now);
  start.setHours(9, 30, 0, 0);
  const end = new Date(now);
  if (!open) end.setHours(16, 0, 0, 0);

  // Fallback: go back up to 3 days (9:30→16:00) in case today has no bars (weekend/holiday)
  const fbStart = new Date(now);
  fbStart.setDate(fbStart.getDate() - 3);
  fbStart.setHours(9, 30, 0, 0);
  const fbEnd = new Date(now);
  fbEnd.setHours(16, 0, 0, 0);

  return {
    marketOpen: open,
    todayET,
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    fbStartISO: fbStart.toISOString(),
    fbEndISO: fbEnd.toISOString(),
  };
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

    // Cache
    const hit = CACHE.get(key);
    if (hit && nowMs - hit.ts < TTL_MS) {
      return NextResponse.json(hit.payload, { headers: { "Cache-Control": "no-store" } });
    }

    // Windows
    const { marketOpen, todayET, startISO, endISO, fbStartISO, fbEndISO } = buildWindows();
    const limit = 240; // minute bars cap
    const debug: any = { marketOpen, todayET, startISO, endISO, fbStartISO, fbEndISO, attempts: [] };

    // Fetch bars with fallback window when needed
    const results = await Promise.all(
      tickers.map(async (symbol) => {
        try {
          let bars: Bar1m[] = await getBars1m(symbol, startISO, endISO, limit);
          debug.attempts.push({ symbol, primaryCount: Array.isArray(bars) ? bars.length : 0 });

          // If no bars in primary, try fallback
          if (!Array.isArray(bars) || bars.length === 0) {
            const fbBars: Bar1m[] = await getBars1m(symbol, fbStartISO, fbEndISO, limit);
            debug.attempts[debug.attempts.length - 1].fallbackCount = Array.isArray(fbBars) ? fbBars.length : 0;
            bars = fbBars;
          }

          if (!Array.isArray(bars) || bars.length === 0) return { symbol, ok: false, reason: "no-bars" };

          const vwap = computeIntradayVWAP(bars);
          const last = bars[bars.length - 1]?.c ?? null;
          if (!vwap || !last) return { symbol, ok: false, reason: "no-vwap-or-last" };

          const above = last >= vwap * 1.0001;
          const below = last <= vwap * 0.9999;

          return {
            symbol,
            ok: true,
            vwap,
            last,
            state: above ? "above" : below ? "below" : "flat",
          };
        } catch (e: any) {
          debug.attempts.push({ symbol, error: String(e?.message || e) });
          return { symbol, ok: false, reason: "exception" };
        }
      })
    );

    let above = 0, below = 0, flat = 0, failures = 0;
    for (const r of results) {
      if (!r?.ok) { failures += 1; continue; }
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
      marketOpen,
      tickers,
      debug, // ← keep this; helps verify windows & counts
    };

    CACHE.set(key, { ts: nowMs, payload });
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Unknown error" }, { status: 500 });
  }
}
