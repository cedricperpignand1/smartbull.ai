// /lib/stocksWorker.ts

// ---------- Types ----------
type QuoteMap = Map<string, { data: any; ts: number }>;
type ProfileMap = Map<string, { data: any; ts: number }>;

const FMP = process.env.FMP_API_KEY || "";

// ---------- Tunables ----------
const TOP_N = 15;                       // show top 15
const WATCHLIST_SIZE = 8;               // quote only first 8 each tick
const QUOTE_INTERVAL_MS = 1500;         // ~1.5s for near real-time
const GAINERS_INTERVAL_MS = 15000;      // refresh gainers every 15s
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000; // profiles once/day

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

// ---------- Core refreshers (with logs) ----------
async function refreshGainers() {
  if (!FMP) {
    console.error("[stocksWorker] Missing FMP_API_KEY env; cannot fetch gainers.");
    return;
  }
  try {
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

// ---------- Payload builder & broadcaster ----------
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
      price: num(g.price ?? q.price),
      changesPercentage: num(g.changesPercentage),
      marketCap: num(q.marketCap),
      sharesOutstanding: num(q.sharesOutstanding),
      volume: num(q.volume),
      avgVolume: num(q.avgVolume ?? q.volAvg),
      employees: p?.fullTimeEmployees != null ? Number(p.fullTimeEmployees) : null,
    };
  });

  return {
    stocks,
    sourceUsed: "FMP" as const,
    updatedAt: new Date().toISOString(),
  };
}

function broadcast(payload: any) {
  lastPayload = payload;
  for (const send of listeners) {
    try {
      send(payload);
    } catch (e) {
      // ignore subscriber errors
    }
  }
}

// ---------- Public API used by routes ----------
export function ensureStocksWorkerStarted() {
  if (started) return;
  started = true;

  if (!FMP) {
    console.error("[stocksWorker] FMP_API_KEY not set; worker will serve empty payloads.");
  } else {
    console.log("[stocksWorker] starting with FMP key present. TOP_N:", TOP_N, "WATCHLIST:", WATCHLIST_SIZE);
  }

  // Initial kick (async, no await so route can respond immediately)
  refreshGainers()
    .then(() => refreshQuotes())
    .then(() => broadcast(buildPayload()))
    .catch((e) => console.error("[stocksWorker] initial kick failed:", e?.message || e));

  // Gainers timer (15s)
  setInterval(async () => {
    await refreshGainers();
    await refreshQuotes();
    broadcast(buildPayload());
  }, GAINERS_INTERVAL_MS);

  // Quotes timer (every 1.5s)
  setInterval(async () => {
    await refreshQuotes();
    broadcast(buildPayload());
  }, QUOTE_INTERVAL_MS);
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
  refreshQuotes().then(() => broadcast(buildPayload())).catch(() => {});
}
