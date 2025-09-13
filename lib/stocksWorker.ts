// /lib/stocksWorker.ts

// ---------- Types ----------
type QuoteMap = Map<string, { data: any; ts: number }>;
type ProfileMap = Map<string, { data: any; ts: number }>;

const FMP = process.env.FMP_API_KEY || "";

// ---------- Tunables ----------
const TOP_N = 15;                            // show top 15
const WATCHLIST_SIZE = 8;                    // quote only first 8 each tick
const QUOTE_INTERVAL_MS = 1500;              // ~1.5s for near real-time (watchlist)
const GAINERS_INTERVAL_MS = 15000;           // refresh gainers every 15s
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;  // profiles once/day

// Bulk refresh for the non-watchlist names so we get volume, etc.
const BULK_NONWATCHLIST_MS = 30_000;         // every 30s is plenty

// NEW: lightly enrich top rows with employees if missing (uses cached helper)
const ENRICH_TOP_N = 12;

// ---------- In-memory state (per server instance) ----------
let gainers: any[] = [];
let quotes: QuoteMap = new Map();
let profiles: ProfileMap = new Map();
let watchlist: string[] = []; // symbols we quote every tick (subset of gainers)
let lastPayload: any = {
  stocks: [] as any[],
  sourceUsed: "FMP",
  updatedAt: new Date().toISOString(),
};

const listeners = new Set<(payload: any) => void>(); // SSE subscribers
let started = false;

// ---------- Helpers ----------
function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

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

async function jfetch(url: string, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url} :: ${text.slice(0, 180)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ⬇️ cached FMP profile helper (uses your 60-min TTL cache)
import { fmpProfileCached } from "./fmpCached";

// Fill missing employees for the first ENRICH_TOP_N rows.
// Uses fmpProfileCached (cheap; 60-min TTL) and also updates our local profiles map.
async function fillEmployeesTopN(rows: Array<{ ticker: string; employees?: number | null }>) {
  const top = rows.slice(0, ENRICH_TOP_N);
  await Promise.all(
    top.map(async (r) => {
      if (r.employees != null) return;

      // If we already have a fresh-ish profile in-memory, use it
      const pMem = profiles.get(r.ticker);
      if (pMem?.data?.fullTimeEmployees != null) {
        const empMem = Number(pMem.data.fullTimeEmployees);
        if (Number.isFinite(empMem)) {
          r.employees = empMem;
          return;
        }
      }

      // Otherwise, grab via cached helper (no extra call if already cached)
      try {
        const p = await fmpProfileCached(r.ticker);
        const emp = Number(p?.fullTimeEmployees);
        if (Number.isFinite(emp)) {
          r.employees = emp;
          // update our local profile cache, too
          profiles.set(r.ticker, {
            data: { ...(pMem?.data ?? {}), ...(p ?? {}), symbol: r.ticker, fullTimeEmployees: emp },
            ts: Date.now(),
          });
        }
      } catch {
        // ignore single-symbol failures
      }
    })
  );
}

// ---------- Core refreshers (with logs) ----------
async function refreshGainers() {
  if (!FMP) {
    console.error("[stocksWorker] Missing FMP_API_KEY env; cannot fetch gainers.");
    return;
  }
  try {
    // NOTE: this endpoint often returns price/% and *may* include some volume fields,
    // but we do not rely on it for volume.
    const url = `https://financialmodelingprep.com/api/v3/stock_market/gainers?apikey=${FMP}`;
    const arr: any[] = await jfetch(url).catch((e) => {
      console.error("[stocksWorker] gainers fetch failed:", e?.message || e);
      return [];
    });

    if (!Array.isArray(arr) || arr.length === 0) {
      console.warn("[stocksWorker] gainers empty response (API limit? after-hours? network?)");
    }

    gainers = Array.isArray(arr) ? arr.slice(0, TOP_N) : [];

    // Choose watchlist = first N symbols
    watchlist = gainers
      .map((r) => String(r.symbol || r.ticker || "").toUpperCase())
      .filter(Boolean)
      .slice(0, WATCHLIST_SIZE);

    // Prefetch profiles for new/expired (once/day) — not critical for trading
    const needProf = watchlist.filter((sym) => {
      const p = profiles.get(sym);
      return !p || Date.now() - p.ts > PROFILE_TTL_MS;
    });

    if (needProf.length) {
      const pURL = `https://financialmodelingprep.com/api/v3/profile/${needProf.join(",")}?apikey=${FMP}`;
      const pData: any[] = await jfetch(pURL).catch((e) => {
        console.error("[stocksWorker] profiles fetch failed:", e?.message || e);
        return [];
      });
      if (!Array.isArray(pData) || pData.length === 0) {
        console.warn("[stocksWorker] profiles empty for:", needProf.join(","));
      }
      for (const p of Array.isArray(pData) ? pData : []) {
        const sym = String(p.symbol || p.ticker || "").toUpperCase();
        profiles.set(sym, { data: p, ts: Date.now() });
      }
    }
  } catch (e: any) {
    console.error("[stocksWorker] refreshGainers error:", e?.message || e);
    // keep previous gainers/watchlist
  }
}

async function refreshQuotes() {
  if (!FMP) return; // already logged in gainers step
  try {
    if (watchlist.length === 0) return;

    // Only fetch those older than ~2s
    const toFetch = watchlist.filter((sym) => {
      const q = quotes.get(sym);
      return !q || Date.now() - q.ts > 2000;
    });
    if (!toFetch.length) return;

    const qURL = `https://financialmodelingprep.com/api/v3/quote/${toFetch.join(",")}?apikey=${FMP}`;
    const qArr: any[] = await jfetch(qURL, 8000).catch((e) => {
      console.error("[stocksWorker] quotes fetch failed:", e?.message || e);
      return [];
    });

    if (!Array.isArray(qArr) || qArr.length === 0) {
      console.warn("[stocksWorker] quotes empty response for:", toFetch.join(","));
    }

    for (const q of Array.isArray(qArr) ? qArr : []) {
      const sym = String(q.symbol || q.ticker || "").toUpperCase();
      quotes.set(sym, { data: q, ts: Date.now() });
    }
  } catch (e: any) {
    console.error("[stocksWorker] refreshQuotes error:", e?.message || e);
  }
}

// Bulk quotes for the remaining gainers (so we get volume for them too)
async function refreshNonWatchlistQuotes() {
  if (!FMP) return;
  try {
    const allSyms = gainers
      .map((r) => String(r.symbol || r.ticker || "").toUpperCase())
      .filter(Boolean);

    const rest = allSyms.filter((s) => !watchlist.includes(s));
    if (!rest.length) return;

    const qURL = `https://financialmodelingprep.com/api/v3/quote/${rest.join(",")}?apikey=${FMP}`;
    const qArr: any[] = await jfetch(qURL, 8000).catch((e) => {
      console.error("[stocksWorker] bulk non-watchlist quotes failed:", e?.message || e);
      return [];
    });

    for (const q of Array.isArray(qArr) ? qArr : []) {
      const sym = String(q.symbol || q.ticker || "").toUpperCase();
      quotes.set(sym, { data: q, ts: Date.now() });
    }
  } catch (e: any) {
    console.error("[stocksWorker] refreshNonWatchlistQuotes error:", e?.message || e);
  }
}

// ---------- Payload builder ----------
function buildPayload() {
  const symbols = gainers
    .map((r) => String(r.symbol || r.ticker || "").toUpperCase())
    .filter(Boolean);

  const stocks = symbols.map((sym) => {
    const g = gainers.find((r) => (r.symbol || r.ticker)?.toUpperCase() === sym) || {};
    const q = quotes.get(sym)?.data || {};
    const p = profiles.get(sym)?.data || {};
    return {
      ticker: sym,
      // Prefer the fresher quote values with fallbacks to gainers fields
      price: num(q.price ?? g.price),
      changesPercentage: num(g.changesPercentage ?? q.changesPercentage),
      marketCap: num(q.marketCap ?? g.marketCap),
      sharesOutstanding: num(q.sharesOutstanding ?? g.sharesOutstanding),
      volume: num(q.volume ?? g.volume),
      avgVolume: num(q.avgVolume ?? q.volAvg ?? g.avgVolume),
      employees: p?.fullTimeEmployees != null ? Number(p.fullTimeEmployees) : null,
    };
  });

  return {
    stocks,
    sourceUsed: "FMP" as const,
    updatedAt: new Date().toISOString(),
  };
}

// ---------- Broadcast helpers ----------
function broadcast(payload: any) {
  lastPayload = payload;
  for (const send of listeners) {
    try {
      send(payload);
    } catch {
      // ignore subscriber errors
    }
  }
}

// Build → enrich top rows (employees) → broadcast
async function buildEnrichAndBroadcast() {
  const payload = buildPayload();
  try {
    await fillEmployeesTopN(payload.stocks);
  } catch {
    // enrichment is best-effort
  }
  broadcast(payload);
}

// ---------- Public API used by routes ----------
export function ensureStocksWorkerStarted() {
  if (started) return;
  started = true;

  if (!FMP) {
    console.error("[stocksWorker] FMP_API_KEY not set; worker will serve empty payloads.");
  } else {
    console.log(
      "[stocksWorker] starting. TOP_N:",
      TOP_N,
      "WATCHLIST:",
      WATCHLIST_SIZE,
      "bulk(non-watchlist) every:",
      BULK_NONWATCHLIST_MS, "ms",
      "enrichTopN:", ENRICH_TOP_N
    );
  }

  // Initial kick (async, no await so route can respond immediately)
  refreshGainers()
    .then(() => Promise.all([refreshQuotes(), refreshNonWatchlistQuotes()]))
    .then(() => buildEnrichAndBroadcast())
    .catch((e) => console.error("[stocksWorker] initial kick failed:", e?.message || e));

  // Gainers timer (15s)
  setInterval(async () => {
    await refreshGainers();
    await refreshQuotes();
    await refreshNonWatchlistQuotes(); // keep rest fresh too
    await buildEnrichAndBroadcast();
  }, GAINERS_INTERVAL_MS);

  // Quotes timer (every 1.5s) — watchlist only
  setInterval(async () => {
    await refreshQuotes();
    await buildEnrichAndBroadcast();
  }, QUOTE_INTERVAL_MS);

  // Non-watchlist bulk quotes (every 30s) — ensures volume is present
  setInterval(async () => {
    await refreshNonWatchlistQuotes();
    await buildEnrichAndBroadcast();
  }, BULK_NONWATCHLIST_MS);
}

export function subscribe(onData: (payload: any) => void) {
  listeners.add(onData);
  // send latest immediately
  try {
    onData(lastPayload);
  } catch {}
  return () => listeners.delete(onData);
}

export function getLatestPayload() {
  return lastPayload;
}

/**
 * (Optional) Allow other parts of your app to override the watchlist dynamically.
 * For example, you could expose a small API route that calls setWatchlist()
 * with your bot’s current candidates.
 */
export function setWatchlist(symbols: string[]) {
  watchlist = symbols
    .map((s) => s.toUpperCase().trim())
    .filter(Boolean)
    .slice(0, WATCHLIST_SIZE);
  // Immediately try to refresh quotes for new symbols (non-blocking)
  refreshQuotes()
    .then(() => refreshNonWatchlistQuotes())
    .then(() => buildEnrichAndBroadcast())
    .catch(() => {});
}
