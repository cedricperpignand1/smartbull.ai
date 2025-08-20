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
  limit_price?: string;
  stop_price?: string;
  order_class?: "simple" | "bracket" | "oco" | "oto";
  legs?: AlpacaOrder[];
};

// ---- Orders ----
// entryType: "market" (recommended) or "limit" (provide limit)
export async function submitBracketBuy(params: {
  symbol: string;
  qty: number; // whole shares
  entryType?: "market" | "limit";
  limit?: number; // required if entryType="limit"
  tp: number;     // take-profit limit price
  sl: number;     // stop-loss stop price
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

  const body: any = {
    symbol,
    qty: String(qty),
    side: "buy",
    type: entryType, // "market" or "limit"
    time_in_force: tif,
    extended_hours,
    order_class: "bracket",
    take_profit: { limit_price: Number(tp).toFixed(4) },
    stop_loss:   { stop_price:  Number(sl).toFixed(4) },
  };

  if (entryType === "limit") {
    if (!Number.isFinite(Number(limit))) {
      throw new Error("submitBracketBuy: limit price required for limit entry");
    }
    body.limit_price = Number(limit).toFixed(4);
  }

  // Correct path: BASE + /v2/orders
  return (await alpacaFetch("/v2/orders", {
    method: "POST",
    body: JSON.stringify(body),
  })) as AlpacaOrder;
}

export async function closePositionMarket(symbol: string) {
  // DELETE closes at market and cancels related legs
  return alpacaFetch(`/v2/positions/${encodeURIComponent(symbol)}`, {
    method: "DELETE",
  });
}

// ---- Optional: quick health helpers ----
export async function getAccount() { return alpacaFetch("/v2/account"); }
export async function getClock() { return alpacaFetch("/v2/clock"); }
export async function getAsset(symbol: string) { return alpacaFetch(`/v2/assets/${encodeURIComponent(symbol)}`); }
