import { NextResponse } from "next/server";

/**
 * SELF-CONTAINED SNAPSHOT ROUTE
 * - Pulls a list of top symbols (FMP gainers) in ONE call
 * - Fetches quotes for all those symbols in ONE batched call
 * - Caches the whole snapshot in-memory for TTL_MS (default 5s)
 * - Coalesces concurrent requests into ONE upstream call
 * - Backs off briefly on 429s and serves last good snapshot
 *
 * ENV required: FMP_API_KEY
 */

// =====================
// Config
// =====================
const TTL_MS = 5000;         // how fresh clients need data
const COOLDOWN_MS = 20_000;  // backoff if provider returns 429
const GAINERS_LIMIT = 30;    // how many symbols to include (30 is plenty)
const QUOTE_CHUNK = 100;     // FMP lets 100+ in one path; chunk to be safe

// =====================
// Cache
// =====================
type Stock = {
  ticker: string;
  price: number | null;
  changesPercentage: number | null;
  volume: number | null;
  avgVolume?: number | null;
  marketCap?: number | null;
};

type Snap = {
  stocks: Stock[];
  updatedAt: string;
  sourceUsed?: string;
  marketOpen?: boolean;
};

let cache: {
  data: Snap | null;
  t: number;
  pending: Promise<Snap> | null;
  last429At: number;
} = {
  data: null,
  t: 0,
  pending: null,
  last429At: 0,
};

// =====================
// Helpers
// =====================
function assertEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function getBaseUrl(headers: Headers) {
  const proto = (headers.get("x-forwarded-proto") || "http").split(",")[0].trim();
  const host = (headers.get("x-forwarded-host") || headers.get("host") || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

// =====================
// Upstream: FMP
// =====================
async function getTopGainersSymbols(limit: number): Promise<string[]> {
  const key = assertEnv("FMP_API_KEY");
  const url = `https://financialmodelingprep.com/api/v3/stock_market/gainers?limit=${limit}&apikey=${key}`;
  const res = await fetch(url, { cache: "no-store" });

  if (res.status === 429) throw new Error("FMP_429");
  if (!res.ok) throw new Error(`FMP gainers failed: ${res.status}`);

  const json = await res.json();
  // response shape: [{symbol, name, price, changesPercentage, ...}, ...]
  const symbols = (Array.isArray(json) ? json : [])
    .map((r: any) => r?.symbol)
    .filter((s: any) => typeof s === "string");
  return symbols;
}

async function getBatchQuotes(symbols: string[]): Promise<Stock[]> {
  if (!symbols.length) return [];
  const key = assertEnv("FMP_API_KEY");

  const chunks = chunk(symbols, QUOTE_CHUNK);
  const results: any[] = [];

  for (const c of chunks) {
    const url = `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(
      c.join(",")
    )}?apikey=${key}`;
    const res = await fetch(url, { cache: "no-store" });

    if (res.status === 429) throw new Error("FMP_429");
    if (!res.ok) throw new Error(`FMP quote failed: ${res.status}`);

    const j = await res.json();
    if (Array.isArray(j)) results.push(...j);
  }

  // Normalize to your UI shape
  const stocks: Stock[] = results.map((r: any) => ({
    ticker: r?.symbol ?? "",
    price: Number.isFinite(Number(r?.price)) ? Number(r.price) : null,
    changesPercentage: Number.isFinite(Number(r?.changesPercentage))
      ? Number(r.changesPercentage)
      : null,
    volume: Number.isFinite(Number(r?.volume)) ? Number(r.volume) : null,
    avgVolume: Number.isFinite(Number(r?.avgVolume)) ? Number(r.avgVolume) : null,
    marketCap: Number.isFinite(Number(r?.marketCap)) ? Number(r.marketCap) : null,
  })).filter(s => s.ticker);

  return stocks;
}

// Optional: quick market-open heuristic (ET hours)
// Keeps your UI badge populated even without your market lib here.
function isLikelyMarketOpenET(now = new Date()): boolean {
  const estNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = estNow.getDay(); // 0 Sun .. 6 Sat
  if (day === 0 || day === 6) return false;
  const h = estNow.getHours();
  const m = estNow.getMinutes();
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 30 && mins <= 16 * 60; // 9:30–16:00 ET
}

// =====================
// Snapshot builder
// =====================
async function fetchUpstreamSnapshot(): Promise<Snap> {
  // 1) Get a list of symbols (single call)
  const symbols = await getTopGainersSymbols(GAINERS_LIMIT);

  // 2) Get their quotes in a single batched call (or 2 if >100)
  const stocks = await getBatchQuotes(symbols);

  // 3) Sort the way your UI expects (by % change desc)
  stocks.sort((a, b) => (b.changesPercentage ?? -Infinity) - (a.changesPercentage ?? -Infinity));

  return {
    stocks,
    updatedAt: new Date().toISOString(),
    sourceUsed: "FMP",
    marketOpen: isLikelyMarketOpenET(),
  };
}

// =====================
// Route
// =====================
export async function GET(request: Request) {
  const now = Date.now();

  // Respect cooldown after a 429
  if (now - cache.last429At < COOLDOWN_MS && cache.data) {
    return NextResponse.json(cache.data);
  }

  // Serve fresh cache
  if (cache.data && now - cache.t < TTL_MS) {
    return NextResponse.json(cache.data);
  }

  // Coalesce: if a fetch is underway, await it
  if (cache.pending) {
    const data = await cache.pending;
    return NextResponse.json(data);
  }

  // Kick off one upstream fetch; everyone else will await this
  cache.pending = (async () => {
    try {
      const data = await fetchUpstreamSnapshot();
      cache.data = data;
      cache.t = Date.now();
      return data;
    } catch (e: any) {
      // If 429, enter cooldown and serve last good snapshot if available
      if (e?.message === "FMP_429") {
        cache.last429At = Date.now();
        if (cache.data) return cache.data;
      }
      // If we have something cached, serve it; otherwise bubble the error
      if (cache.data) return cache.data;
      throw e;
    } finally {
      cache.pending = null;
    }
  })();

  const data = await cache.pending;
  return NextResponse.json(data);
}
