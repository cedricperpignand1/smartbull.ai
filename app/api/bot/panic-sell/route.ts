// app/api/bot/panic-sell/route.ts
import { NextResponse } from "next/server";

/**
 * PANIC SELL — close ALL open positions immediately with MARKET orders.
 * Secured by a simple passkey (default "9340"); also verify on server.
 *
 * Frontend caller (already added):
 * POST /api/bot/panic-sell  { key: "9340" }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// ---- Config (envs with safe defaults) ----
const PANIC_PASSKEY = process.env.PANIC_PASSKEY || "9340"; // << you can move to env later
const ALPACA_KEY   = process.env.ALPACA_KEY
  || process.env.ALPACA_API_KEY
  || process.env.NEXT_PUBLIC_ALPACA_API_KEY_ID
  || "";
const ALPACA_SECRET = process.env.ALPACA_SECRET
  || process.env.ALPACA_API_SECRET
  || process.env.NEXT_PUBLIC_ALPACA_API_SECRET
  || "";
const ALPACA_BASE = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets"; // trading base

// Convenience for JSON replies
function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

// Minimal typed shape for Alpaca responses
type AlpacaPosition = {
  symbol: string;
  qty: string;       // note: string in Alpaca JSON
  side?: "long" | "short";
};

async function alpacaFetch(path: string, init?: RequestInit) {
  const url = `${ALPACA_BASE}${path}`;
  const headers = {
    ...(init?.headers || {}),
    "APCA-API-KEY-ID": ALPACA_KEY,
    "APCA-API-SECRET-KEY": ALPACA_SECRET,
    "Content-Type": "application/json",
  };
  const res = await fetch(url, { ...init, headers, cache: "no-store" });
  return res;
}

async function cancelAllOpenOrders() {
  // DELETE /v2/orders   (cancels all open orders)
  try {
    const r = await alpacaFetch("/v2/orders", { method: "DELETE" });
    // Alpaca returns 207 (multi-status) sometimes; treat non-500s as best-effort success
    if (!r.ok && r.status !== 207) {
      const text = await r.text().catch(() => "");
      return { ok: false, error: `Cancel orders failed: ${r.status} ${text}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Cancel orders request failed" };
  }
}

async function listPositions(): Promise<{ ok: boolean; positions: AlpacaPosition[]; error?: string }> {
  try {
    const r = await alpacaFetch("/v2/positions", { method: "GET" });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return { ok: false, positions: [], error: `List positions failed: ${r.status} ${text}` };
    }
    const data = (await r.json()) as AlpacaPosition[] | any;
    const arr = Array.isArray(data) ? data : [];
    return { ok: true, positions: arr };
  } catch (e: any) {
    return { ok: false, positions: [], error: e?.message || "List positions request failed" };
  }
}

async function submitMarketOrder(symbol: string, side: "buy" | "sell", qty: number) {
  // POST /v2/orders
  const body = {
    symbol,
    qty,
    side,
    type: "market",
    time_in_force: "day",
  };
  const r = await alpacaFetch("/v2/orders", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Order ${side} ${qty} ${symbol} failed: ${r.status} ${text}`);
  }
  const j = await r.json().catch(() => ({}));
  return j;
}

export async function POST(req: Request) {
  try {
    // 1) Verify passkey
    const { key } = await req.json().catch(() => ({}));
    if (!key || String(key) !== PANIC_PASSKEY) {
      return json({ ok: false, error: "Invalid passkey." }, 401);
    }

    // 2) Verify Alpaca creds exist
    if (!ALPACA_KEY || !ALPACA_SECRET) {
      return json({ ok: false, error: "Missing Alpaca credentials on server." }, 500);
    }

    // 3) Best-effort cancel all open orders first (avoid rejections)
    const cancelRes = await cancelAllOpenOrders();
    if (!cancelRes.ok) {
      // Not fatal for panic; include in response
      console.warn(cancelRes.error);
    }

    // 4) Fetch positions
    const posRes = await listPositions();
    if (!posRes.ok) {
      return json({ ok: false, error: posRes.error || "Failed to fetch positions." }, 502);
    }
    const positions = posRes.positions || [];
    if (positions.length === 0) {
      return json({ ok: true, closed: [], note: "No open positions." });
    }

    // 5) Submit market orders to flatten each position
    const closed: Array<{ symbol: string; side: "buy" | "sell"; qty: number; orderId?: string }> = [];
    const errors: Array<{ symbol: string; err: string }> = [];

    for (const p of positions) {
      const symbol = p.symbol;
      const rawQty = Number(p.qty);
      if (!Number.isFinite(rawQty) || rawQty === 0) continue;

      // Long positions: SELL; Short positions: BUY to cover
      const side: "buy" | "sell" = rawQty > 0 ? "sell" : "buy";
      const qty = Math.abs(rawQty);

      try {
        const order = await submitMarketOrder(symbol, side, qty);
        closed.push({ symbol, side, qty, orderId: order?.id });
      } catch (e: any) {
        errors.push({ symbol, err: e?.message || "order failed" });
      }
    }

    const ok = errors.length === 0;
    return json({ ok, closed, errors, canceledOpenOrders: cancelRes.ok ?? false });
  } catch (err: any) {
    console.error("panic-sell route error:", err);
    return json({ ok: false, error: err?.message || "panic-sell failed" }, 500);
  }
}
