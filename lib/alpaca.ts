// app/lib/alpaca.ts

// ---- Base & Keys (robust) ----
const RAW_BASE =
  (process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets").trim();
// remove trailing slashes and a trailing "/v2" if present
const BASE = RAW_BASE.replace(/\/+$/, "").replace(/\/v2$/, "");
const KEY =
  process.env.ALPACA_API_KEY_ID ||
  process.env.ALPACA_API_KEY ||
  process.env.NEXT_PUBLIC_ALPACA_API_KEY_ID ||
  "";
const SEC =
  process.env.ALPACA_API_SECRET_KEY ||
  process.env.ALPACA_SECRET_KEY ||
  process.env.NEXT_PUBLIC_ALPACA_API_SECRET_KEY ||
  "";

// ---- helpers ----
function headers() {
  return {
    "APCA-API-KEY-ID": KEY,
    "APCA-API-SECRET-KEY": SEC,
    "Content-Type": "application/json",
  };
}

async function alpacaFetch(path: string, opts: RequestInit = {}) {
  const url = `${BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  const res = await fetch(url, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }

  if (!res.ok) {
    const msg = json?.message || json?.error || text || `HTTP ${res.status}`;
    const err = new Error(`Alpaca error: ${msg}`);
    (err as any).status = res.status;
    (err as any).body = json ?? text;
    throw err;
  }
  return json;
}

// ---- Tick math (US equities) ----
// ≥ $1 -> $0.01 ticks; < $1 -> $0.0001 ticks.
function tickSizeFor(price: number) {
  return price >= 1 ? 0.01 : 0.0001;
}
function ceilToTick(x: number, tick: number) {
  return Math.ceil(x / tick) * tick;
}
function floorToTick(x: number, tick: number) {
  return Math.floor(x / tick) * tick;
}
function decsForTick(tick: number) {
  return tick === 0.01 ? 2 : 4;
}

// ---- Types ----
export type AlpacaOrder = {
  id: string;
  client_order_id: string;
  status: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit";
  qty?: string;
  filled_qty?: string;
  filled_avg_price?: string;
  limit_price?: string;
  stop_price?: string;
  order_class?: "simple" | "bracket" | "oco" | "oto";
  legs?: AlpacaOrder[];
  parent_order_id?: string;
  submitted_at?: string;
  filled_at?: string;
};

// ---- Orders ----
// entryType: "market" (recommended) or "limit" (provide limit)
export async function submitBracketBuy(params: {
  symbol: string;
  qty: number;                // whole shares
  entryType?: "market" | "limit";
  limit?: number;             // required if entryType="limit" (unrounded)
  tp: number;                 // take-profit target (unrounded)
  sl: number;                 // stop-loss trigger (unrounded)
  tif?: "day" | "gtc" | "opg" | "ioc" | "fok" | "cls";
  extended_hours?: boolean;
}) {
  const {
    symbol,
    qty,
    entryType = "market",
    limit,
    tp,
    sl,
    tif = "day",
    extended_hours = false,
  } = params;

  // ----- Round TP/SL to valid exchange ticks -----
  const tpTick = tickSizeFor(tp);
  const slTick = tickSizeFor(sl);
  const tpRO   = ceilToTick(tp, tpTick);      // round UP for TP limit
  const slRO   = floorToTick(sl, slTick);     // round DOWN for SL stop
  const tpStr  = tpRO.toFixed(decsForTick(tpTick));
  const slStr  = slRO.toFixed(decsForTick(slTick));

  const body: any = {
    symbol,
    qty: String(qty),
    side: "buy",
    type: entryType, // "market" or "limit"
    time_in_force: tif,
    extended_hours,
    order_class: "bracket",
    take_profit: { limit_price: tpStr },
    // Stop MARKET for reliability (only stop_price needed)
    stop_loss:   { stop_price:  slStr },
  };

  if (entryType === "limit") {
    if (!Number.isFinite(Number(limit))) {
      throw new Error("submitBracketBuy: limit price required for limit entry");
    }
    // For a BUY limit, bias UP to ensure it’s not sub-tick and has better fill odds
    const limTick = tickSizeFor(Number(limit));
    const limRO   = ceilToTick(Number(limit), limTick);
    body.limit_price = limRO.toFixed(decsForTick(limTick));
  }

  // Correct path: BASE + /v2/orders
  return (await alpacaFetch("/v2/orders", {
    method: "POST",
    body: JSON.stringify(body),
  })) as AlpacaOrder;
}

export async function closePositionMarket(symbol: string) {
  // DELETE closes at market and cancels related bracket legs
  return alpacaFetch(`/v2/positions/${encodeURIComponent(symbol)}`, {
    method: "DELETE",
  });
}

// ---- Optional: quick health helpers ----
export async function getAccount() { return alpacaFetch("/v2/account"); }
export async function getClock()   { return alpacaFetch("/v2/clock"); }
export async function getAsset(symbol: string) {
  return alpacaFetch(`/v2/assets/${encodeURIComponent(symbol)}`);
}

// ---- Extra helpers for syncing orders/positions ----
export async function getOrder(id: string, nested = true) {
  const qs = nested ? "?nested=true" : "";
  return alpacaFetch(`/v2/orders/${encodeURIComponent(id)}${qs}`);
}

export async function listOrders(params: {
  status?: "open" | "closed" | "all";
  symbols?: string[];
  after?: string;   // ISO8601
  until?: string;   // ISO8601
  limit?: number;
  nested?: boolean;
} = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set("status", params.status);
  if (params.after)  q.set("after", params.after);
  if (params.until)  q.set("until", params.until);
  if (params.limit)  q.set("limit", String(params.limit));
  if (params.nested) q.set("nested", "true");
  if (params.symbols && params.symbols.length) {
    q.set("symbols", params.symbols.join(","));
  }
  const suf = q.toString() ? `?${q.toString()}` : "";
  return alpacaFetch(`/v2/orders${suf}`);
}

export async function listPositions() {
  return alpacaFetch(`/v2/positions`);
}

// returns null if no active position for symbol
export async function getPosition(symbol: string) {
  try {
    return await alpacaFetch(`/v2/positions/${encodeURIComponent(symbol)}`);
  } catch (e: any) {
    if (e?.status === 404) return null;
    throw e;
  }
}
