// app/lib/alpaca.ts
const BASE = (process.env.ALPACA_BASE_URL?.trim() || "https://paper-api.alpaca.markets").replace(/\/+$/,'');
const KEY  = process.env.ALPACA_API_KEY_ID!;
const SEC  = process.env.ALPACA_API_SECRET_KEY!;

function headers() {
  return {
    "APCA-API-KEY-ID": KEY,
    "APCA-API-SECRET-KEY": SEC,
    "Content-Type": "application/json",
  };
}

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

export async function submitBracketBuy(params: {
  symbol: string;
  qty: number;          // whole shares
  limit: number;        // entry limit
  tp: number;           // take-profit limit
  sl: number;           // stop-loss stop
  tif?: "day" | "gtc";
}) {
  const body = {
    symbol: params.symbol,
    qty: String(params.qty),
    side: "buy",
    type: "limit",
    time_in_force: params.tif || "day",
    limit_price: Number(params.limit).toFixed(4),
    extended_hours: false,
    order_class: "bracket",
    take_profit: { limit_price: Number(params.tp).toFixed(4) },
    stop_loss:   { stop_price:  Number(params.sl).toFixed(4) },
  };

  const res = await fetch(`${BASE}/v2/orders`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Alpaca order failed (${res.status}): ${txt}`);
  }
  return (await res.json()) as AlpacaOrder;
}

export async function closePositionMarket(symbol: string) {
  const res = await fetch(`${BASE}/v2/positions/${encodeURIComponent(symbol)}`, {
    method: "DELETE",
    headers: headers(),
    cache: "no-store",
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Alpaca close position failed (${res.status}): ${txt}`);
  }
  return res.json().catch(() => ({}));
}
