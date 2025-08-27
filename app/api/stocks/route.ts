// app/api/stocks/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Stock = {
  ticker: string;
  price: number | null;
  changesPercentage: number | null;
  marketCap: number | null;
  sharesOutstanding: number | null;
  volume: number | null;
  avgVolume?: number | null;
  employees?: number | null;
};

const FMP_API_KEY = process.env.FMP_API_KEY;

// ---------- Market hours check ----------
function isMarketOpenNow(): boolean {
  const now = new Date();
  const ny = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const d = ny.getDay();
  const h = ny.getHours();
  const m = ny.getMinutes();
  const isWeekday = d >= 1 && d <= 5;
  const isHours = (h > 9 || (h === 9 && m >= 30)) && h < 16;
  return isWeekday && isHours;
}

// ---------- In-memory caches ----------
const gainersCache = { data: [] as any[], ts: 0 };
const quotesCache = new Map<string, { data: any; ts: number }>();
const profilesCache = new Map<string, { data: any; ts: number }>();

const IN_FLIGHT = new Map<string, Promise<any>>();

// ---------- TTLs ----------
const TTL_GAINERS_OPEN = 15_000;    // 15s
const TTL_GAINERS_CLOSED = 60_000;  // 60s
const TTL_QUOTES = 2_000;           // 2s
const TTL_PROFILE = 24 * 60 * 60 * 1000; // 1 day

// ---------- Helpers ----------
function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchJSON(url: string, ttl: number) {
  const now = Date.now();
  if (IN_FLIGHT.has(url)) return IN_FLIGHT.get(url);
  const p = (async () => {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  })();
  IN_FLIGHT.set(url, p);
  try {
    const data = await p;
    // No per-URL caching here — handled per-symbol below
    return data;
  } finally {
    IN_FLIGHT.delete(url);
  }
}

// ---------- Main ----------
export async function GET() {
  try {
    const marketOpen = isMarketOpenNow();
    const now = Date.now();

    // 1) Get gainers list (only if TTL expired)
    const gTTL = marketOpen ? TTL_GAINERS_OPEN : TTL_GAINERS_CLOSED;
    if (now - gainersCache.ts > gTTL) {
      const url = `https://financialmodelingprep.com/api/v3/stock_market/gainers?apikey=${FMP_API_KEY}`;
      const gainers = await fetchJSON(url, gTTL).catch(() => []);
      gainersCache.data = Array.isArray(gainers) ? gainers.slice(0, 15) : [];
      gainersCache.ts = now;
    }
    const topSymbols = gainersCache.data
      .map((r: any) => String(r.symbol || r.ticker || "").toUpperCase())
      .filter(Boolean);

    // 2) Quotes for NEW or stale symbols
    const quotesNeeded: string[] = [];
    for (const sym of topSymbols) {
      const q = quotesCache.get(sym);
      if (!q || now - q.ts > TTL_QUOTES) {
        quotesNeeded.push(sym);
      }
    }
    if (quotesNeeded.length > 0) {
      const qURL = `https://financialmodelingprep.com/api/v3/quote/${quotesNeeded.join(",")}?apikey=${FMP_API_KEY}`;
      const qData: any[] = await fetchJSON(qURL, TTL_QUOTES).catch(() => []);
      for (const q of qData) {
        const sym = String(q.symbol || q.ticker || "").toUpperCase();
        quotesCache.set(sym, { data: q, ts: now });
      }
    }

    // 3) Profiles only for NEW symbols or expired
    const profilesNeeded: string[] = [];
    for (const sym of topSymbols) {
      const p = profilesCache.get(sym);
      if (!p || now - p.ts > TTL_PROFILE) {
        profilesNeeded.push(sym);
      }
    }
    if (profilesNeeded.length > 0) {
      const pURL = `https://financialmodelingprep.com/api/v3/profile/${profilesNeeded.join(",")}?apikey=${FMP_API_KEY}`;
      const pData: any[] = await fetchJSON(pURL, TTL_PROFILE).catch(() => []);
      for (const p of pData) {
        const sym = String(p.symbol || p.ticker || "").toUpperCase();
        profilesCache.set(sym, { data: p, ts: now });
      }
    }

    // 4) Build final stocks array
    const stocks: Stock[] = topSymbols.map((sym) => {
      const g = gainersCache.data.find((r) => (r.symbol || r.ticker)?.toUpperCase() === sym) || {};
      const q = quotesCache.get(sym)?.data || {};
      const p = profilesCache.get(sym)?.data || {};
      return {
        ticker: sym,
        price: num(g.price ?? q.price),
        changesPercentage: num(g.changesPercentage),
        marketCap: num(q.marketCap),
        sharesOutstanding: num(q.sharesOutstanding),
        volume: num(q.volume),
        avgVolume: num(q.avgVolume ?? q.volAvg),
        employees: p?.fullTimeEmployees != null ? Number(p.fullTimeEmployees) : null,
      };
    });

    return NextResponse.json({
      stocks,
      sourceUsed: "FMP" as const,
      updatedAt: new Date().toISOString(),
      cached: false,
    });
  } catch (err: any) {
    console.error("[/api/stocks] ERROR:", err?.message || err);
    return NextResponse.json(
      { errorMessage: "Failed to load data", stocks: [], sourceUsed: "FMP" },
      { status: 200 }
    );
  }
}
