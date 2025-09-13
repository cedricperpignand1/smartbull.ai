// app/api/fmp/candles/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const FMP_API_KEY = process.env.FMP_API_KEY; // ❗ do not fallback

// Allowed FMP intervals
const ALLOWED = new Set(["1min", "5min", "15min", "30min", "1hour", "4hour"]);

// Interval-aware TTLs (tune as you like)
const TTL_BY_INTERVAL_MS: Record<string, number> = {
  "1min": 4_000,    // ~4s when very hot
  "5min": 30_000,
  "15min": 90_000,
  "30min": 120_000,
  "1hour": 300_000,
  "4hour": 900_000,
};

// Backoff window after 429
const COOLDOWN_MS = 20_000;

// Max bars we’ll ever return (and slice from cache)
const MAX_LIMIT = 1000;

// -------- Cache (per symbol|interval) --------
type Candle = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
type Entry = {
  data: Candle[] | null;     // newest … oldest or oldest … newest (we store oldest→newest)
  fetchedAt: number;         // ms
  pending: Promise<Candle[]> | null;
  last429At: number;         // ms
};

const cache: Record<string, Entry> = Object.create(null);

// Helpers
function isMarketOpenET(now = new Date()): boolean {
  const d = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}
function getTTL(interval: string): number {
  const base = TTL_BY_INTERVAL_MS[interval] ?? 30_000;
  // After-hours & weekends: stretch TTL to reduce churn
  return isMarketOpenET() ? base : Math.max(base, 60_000);
}
function cacheKey(symbol: string, interval: string) {
  return `${symbol}|${interval}`;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const symbolRaw = searchParams.get("symbol");
    let interval = (searchParams.get("interval") || "1min").toLowerCase();
    const limitReq = Math.max(1, Math.min(MAX_LIMIT, Number(searchParams.get("limit") || 240)));

    if (!symbolRaw) {
      return NextResponse.json({ error: "symbol required" }, { status: 400 });
    }
    if (!ALLOWED.has(interval)) interval = "1min";
    if (!FMP_API_KEY) {
      console.error("[/api/fmp/candles] Missing FMP_API_KEY");
      return NextResponse.json({ error: "Server not configured" }, { status: 500 });
    }

    const symbol = symbolRaw.trim().toUpperCase();
    const key = cacheKey(symbol, interval);
    const now = Date.now();
    const ttl = getTTL(interval);

    // Ensure cache bucket exists
    if (!cache[key]) {
      cache[key] = { data: null, fetchedAt: 0, pending: null, last429At: 0 };
    }
    const entry = cache[key];

    // 429 cooldown: serve stale if present
    if (entry.last429At && now - entry.last429At < COOLDOWN_MS && entry.data) {
      return respond(entry.data.slice(-limitReq), "stale-429");
    }

    // Fresh cache hit (and we already have at least `limitReq` bars)
    if (entry.data && now - entry.fetchedAt < ttl && entry.data.length >= limitReq) {
      return respond(entry.data.slice(-limitReq), "cache-hit");
    }

    // Coalesce: if a fetch is in-flight, await it
    if (entry.pending) {
      try {
        const data = await entry.pending;
        return respond(data.slice(-limitReq), "coalesced");
      } catch (e) {
        // If pending failed, try stale
        if (entry.data) return respond(entry.data.slice(-limitReq), "stale-on-error");
        throw e;
      }
    }

    // Kick off one upstream fetch, store promise
    entry.pending = (async () => {
      const url = `https://financialmodelingprep.com/api/v3/historical-chart/${interval}/${encodeURIComponent(
        symbol
      )}?apikey=${FMP_API_KEY}`;

      // 8s timeout so hung upstream calls don’t pile up
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 8_000);

      let r: Response;
      try {
        r = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      } finally {
        clearTimeout(to);
      }

      if (r.status === 429) {
        entry.last429At = Date.now();
        // Throw so callers can serve stale if present
        throw new Error("FMP_429");
      }
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        console.error("[/api/fmp/candles] Upstream error", r.status, text);
        throw new Error(`FMP_${r.status}`);
      }

      const raw = await r.json();
      const arr = Array.isArray(raw) ? raw : [];

      // FMP returns newest-first; take up to MAX_LIMIT, then reverse -> oldest→newest
      const newestFirst = arr.slice(0, MAX_LIMIT);
      const chron = newestFirst.reverse();

      // Normalize
      const normalized: Candle[] = chron.map((c: any) => ({
        date: String(c?.date ?? ""),
        open: Number(c?.open ?? 0),
        high: Number(c?.high ?? 0),
        low: Number(c?.low ?? 0),
        close: Number(c?.close ?? 0),
        volume: Number(c?.volume ?? 0),
      }));

      // Update cache
      entry.data = normalized;
      entry.fetchedAt = Date.now();
      entry.last429At = 0;
      return normalized;
    })();

    try {
      const fresh = await entry.pending;
      return respond(fresh.slice(-limitReq), "fresh");
    } catch (err: any) {
      // Serve stale if we have it
      if (entry.data) return respond(entry.data.slice(-limitReq), "stale-on-error");
      const msg =
        err?.name === "AbortError" ? "Upstream timeout" : err?.message || "Unknown error";
      return NextResponse.json({ error: msg }, { status: 502 });
    } finally {
      entry.pending = null;
    }
  } catch (err: any) {
    console.error("[/api/fmp/candles] ERROR:", err?.message || err);
    const msg =
      err?.name === "AbortError" ? "Upstream timeout" : err?.message || "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// Small helper to add cache headers + debug marker
function respond(candles: Candle[], source: "fresh" | "cache-hit" | "coalesced" | "stale-429" | "stale-on-error") {
  const res = NextResponse.json({ candles });
  // Give clients permission to cache briefly. They’ll still hit our in-memory cache
  const maxAge = 2; // seconds — keep tiny so your server cache stays primary
  res.headers.set("Cache-Control", `public, max-age=${maxAge}, stale-while-revalidate=30`);
  res.headers.set("X-Source", source);
  return res;
}
