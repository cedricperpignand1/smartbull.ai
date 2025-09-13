// app/lib/fmpCached.ts
import { createTTLCache } from "./ttlCache";

const FMP_API_KEY = process.env.FMP_API_KEY || "";

// ---- TTLs (tuneable) ----
const TTL_PROFILE_MS = 60 * 60 * 1000; // 60 min
const TTL_RATIOS_MS  = 60 * 60 * 1000; // 60 min
const TTL_NEWS_MS    = 15 * 60 * 1000; // 15 min
const TTL_QUOTE_MS   = 20 * 1000;      // 20 sec
const TTL_AVGVOL_MS  = 30 * 60 * 1000; // 30 min

// ---- Caches ----
const cacheProfile = createTTLCache<any>(TTL_PROFILE_MS);
const cacheRatios  = createTTLCache<any>(TTL_RATIOS_MS);
const cacheNews    = createTTLCache<any>(TTL_NEWS_MS);
const cacheQuote   = createTTLCache<any>(TTL_QUOTE_MS);
const cacheAvgVol  = createTTLCache<number | null>(TTL_AVGVOL_MS);

// ---- Minimal fetcher ----
async function _fmpFetchJSON(url: string) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`FMP ${r.status}`);
  return r.json();
}

// ---- Individual endpoints ----
async function _profile(ticker: string) {
  const u = `https://financialmodelingprep.com/api/v3/profile/${ticker}?apikey=${FMP_API_KEY}`;
  const j = await _fmpFetchJSON(u);
  return Array.isArray(j) && j.length ? j[0] : null;
}

async function _ratiosTTM(ticker: string) {
  const u = `https://financialmodelingprep.com/api/v3/ratios-ttm/${ticker}?apikey=${FMP_API_KEY}`;
  const j = await _fmpFetchJSON(u);
  return Array.isArray(j) && j.length ? j[0] : null;
}

async function _news(ticker: string, limit: number) {
  const lim = Math.max(1, Math.min(limit, 5));
  const u = `https://financialmodelingprep.com/api/v3/stock_news?tickers=${ticker}&limit=${lim}&apikey=${FMP_API_KEY}`;
  const j = await _fmpFetchJSON(u);
  return Array.isArray(j) ? j : [];
}

async function _quote(ticker: string) {
  const u = `https://financialmodelingprep.com/api/v3/quote/${ticker}?apikey=${FMP_API_KEY}`;
  const j = await _fmpFetchJSON(u);
  return Array.isArray(j) && j.length ? j[0] : null;
}

// ---- NEW: batched quotes (1 call for many tickers) ----
export async function fmpQuoteManyCached(tickers: string[]): Promise<Record<string, any>> {
  const wanted = Array.from(new Set(tickers.map(t => String(t).toUpperCase()).filter(Boolean)));
  if (!wanted.length) return {};

  // Build the URL once
  const u = `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(wanted.join(","))}?apikey=${FMP_API_KEY}`;
  const j = await _fmpFetchJSON(u);
  const arr: any[] = Array.isArray(j) ? j : [];

  // Normalize → map and hydrate per-ticker cache without extra network calls
  const out: Record<string, any> = {};
  for (const q of arr) {
    const sym = String(q?.symbol || q?.ticker || "").toUpperCase();
    if (!sym) continue;
    out[sym] = q;

    // Populate the per-ticker quote cache (no fetch) so future calls within 20s hit cache
    const key = `quote:${sym}`;
    await cacheQuote.getOrSet(key, async () => q, TTL_QUOTE_MS);
  }
  return out;
}

// ---- Historical avgVolume (fallback only) ----
async function _avgVolFromHistory(ticker: string): Promise<number | null> {
  const u = `https://financialmodelingprep.com/api/v3/historical-price-full/${ticker}?serietype=line&timeseries=30&apikey=${FMP_API_KEY}`;
  const j = await _fmpFetchJSON(u);
  const hist = j?.historical;
  if (!Array.isArray(hist) || !hist.length) return null;
  let sum = 0, n = 0;
  for (const d of hist) {
    const v = Number(d?.volume);
    if (Number.isFinite(v)) { sum += v; n++; }
  }
  return n ? Math.round(sum / n) : null;
}

// ---- Cached wrappers (single) ----
export async function fmpProfileCached(ticker: string) {
  const key = `profile:${ticker.toUpperCase()}`;
  return cacheProfile.getOrSet(key, () => _profile(ticker), TTL_PROFILE_MS).catch(() => null);
}

export async function fmpRatiosTTMCached(ticker: string) {
  const key = `ratiosTTM:${ticker.toUpperCase()}`;
  return cacheRatios.getOrSet(key, () => _ratiosTTM(ticker), TTL_RATIOS_MS).catch(() => null);
}

export async function fmpNewsCached(ticker: string, limit = 3) {
  const key = `news:${ticker.toUpperCase()}:${limit}`;
  return cacheNews.getOrSet(key, () => _news(ticker, limit), TTL_NEWS_MS).catch(() => []);
}

export async function fmpQuoteCached(ticker: string) {
  const key = `quote:${ticker.toUpperCase()}`;
  return cacheQuote.getOrSet(key, () => _quote(ticker), TTL_QUOTE_MS).catch(() => null);
}

/**
 * Avg volume strategy:
 * 1) Prefer avgVolume from a **provided quote** or from the quote cache (20s)
 * 2) Only if missing, hit historical (heavy; 30m cache)
 */
export async function fmpAvgVolumeSmartCached(ticker: string, preloadedQuote?: any): Promise<number | null> {
  const key = `avgvol:${ticker.toUpperCase()}`;
  return cacheAvgVol.getOrSet(
    key,
    async () => {
      try {
        const q = preloadedQuote ?? (await fmpQuoteCached(ticker));
        const direct =
          Number(q?.avgVolume) ??
          Number(q?.volAvg) ??
          Number(q?.averageVolume);
        if (Number.isFinite(direct)) return Number(direct);
      } catch { /* ignore */ }

      try {
        return await _avgVolFromHistory(ticker);
      } catch {
        return null;
      }
    },
    TTL_AVGVOL_MS
  ).catch(() => null);
}
