// app/lib/fmpCached.ts
import { createTTLCache } from "./ttlCache";


const FMP_API_KEY = process.env.FMP_API_KEY || "";

// ---- TTLs (tuneable) ----
// Fundamentals / profile: essentially static intraday
const TTL_PROFILE_MS = 60 * 60 * 1000;     // 60 min
const TTL_RATIOS_MS  = 60 * 60 * 1000;     // 60 min
// News can be shorter but doesn't need to be per-tick
const TTL_NEWS_MS    = 15 * 60 * 1000;     // 15 min
// Quotes change fast; small TTL to slash bursts across routes
const TTL_QUOTE_MS   = 20 * 1000;          // 20 sec
// AvgVolume: semi-static; prefer quote.avgVolume then fall back to historical
const TTL_AVGVOL_MS  = 30 * 60 * 1000;     // 30 min

// ---- Caches ----
const cacheProfile = createTTLCache<any>(TTL_PROFILE_MS);
const cacheRatios  = createTTLCache<any>(TTL_RATIOS_MS);
const cacheNews    = createTTLCache<any>(TTL_NEWS_MS);
const cacheQuote   = createTTLCache<any>(TTL_QUOTE_MS);
const cacheAvgVol  = createTTLCache<number | null>(TTL_AVGVOL_MS);

// ---- Bare fetchers (no caching) ----
async function _fmpFetchJSON(url: string) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`FMP ${r.status}`);
  return r.json();
}

// Profile
async function _profile(ticker: string) {
  const u = `https://financialmodelingprep.com/api/v3/profile/${ticker}?apikey=${FMP_API_KEY}`;
  const j = await _fmpFetchJSON(u);
  return Array.isArray(j) && j.length ? j[0] : null;
}

// Ratios TTM
async function _ratiosTTM(ticker: string) {
  const u = `https://financialmodelingprep.com/api/v3/ratios-ttm/${ticker}?apikey=${FMP_API_KEY}`;
  const j = await _fmpFetchJSON(u);
  return Array.isArray(j) && j.length ? j[0] : null;
}

// News
async function _news(ticker: string, limit: number) {
  const lim = Math.max(1, Math.min(limit, 5)); // clamp for safety
  const u = `https://financialmodelingprep.com/api/v3/stock_news?tickers=${ticker}&limit=${lim}&apikey=${FMP_API_KEY}`;
  const j = await _fmpFetchJSON(u);
  return Array.isArray(j) ? j : [];
}

// Quote
async function _quote(ticker: string) {
  const u = `https://financialmodelingprep.com/api/v3/quote/${ticker}?apikey=${FMP_API_KEY}`;
  const j = await _fmpFetchJSON(u);
  return Array.isArray(j) && j.length ? j[0] : null;
}

// Historical as a fallback ONLY when quote lacks avgVolume
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

// ---- Cached wrappers ----
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
 * 1) Try quote.avgVolume/volAvg/averageVolume (cheap; cached ~20s via quote cache)
 * 2) Only if missing, hit historical (expensive; cached 30 min)
 */
export async function fmpAvgVolumeSmartCached(ticker: string): Promise<number | null> {
  const key = `avgvol:${ticker.toUpperCase()}`;
  return cacheAvgVol.getOrSet(
    key,
    async () => {
      // Try quote first (uses its own 20s cache)
      try {
        const q = await fmpQuoteCached(ticker);
        const direct =
          Number(q?.avgVolume) ??
          Number(q?.volAvg) ??
          Number(q?.averageVolume);

        if (Number.isFinite(direct)) return Number(direct);
      } catch { /* ignore */ }

      // Fallback to historical (heavier; long TTL)
      try {
        return await _avgVolFromHistory(ticker);
      } catch {
        return null;
      }
    },
    TTL_AVGVOL_MS
  ).catch(() => null);
}
