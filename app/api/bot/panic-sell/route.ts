// app/api/bot/panic-sell/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Expected env (any of these will work):
 * - PANIC_PASSKEY                (use 9340)
 * - ALPACA_KEY | ALPACA_API_KEY | ALPACA_KEY_ID
 * - ALPACA_SECRET | ALPACA_API_SECRET | ALPACA_SECRET_KEY   <-- now supports your name
 * - ALPACA_BASE_URL (https://paper-api.alpaca.markets or https://api.alpaca.markets)
 */

const PANIC_PASSKEY = process.env.PANIC_PASSKEY || "9340";

const ALPACA_KEY =
  process.env.ALPACA_KEY ||
  process.env.ALPACA_API_KEY ||
  process.env.ALPACA_KEY_ID ||
  "";

const ALPACA_SECRET =
  process.env.ALPACA_SECRET ||
  process.env.ALPACA_API_SECRET ||
  process.env.ALPACA_SECRET_KEY || // <-- support your current name
  "";

const ALPACA_BASE = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

type AlpacaPosition = { symbol: string; qty: string };

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
  try {
    const r = await alpacaFetch("/v2/orders", { method: "DELETE" });
    const body = await r.text().catch(() => "");
    if (!r.ok && r.status !== 207 && r.status !== 204) {
      console.error("Alpaca cancel orders failed:", r.status, body);
      return { ok: false, error: `Alpaca cancel orders failed: ${r.status}` };
    }
    return { ok: true };
  } catch (e: any) {
    console.error("Cancel orders error:", e);
    return { ok: false, error: e?.message || "Cancel orders request failed" };
  }
}

async function listPositions() {
  try {
    const r = await alpacaFetch("/v2/positions", { method: "GET" });
    const bodyText = await r.text();
    if (!r.ok) {
      console.error("Alpaca list positions failed:", r.status, bodyText);
      return { ok: false, positions: [], error: `List positions failed: ${r.status}` };
    }
    let data: any = [];
    try { data = JSON.parse(bodyText); } catch {}
    return { ok: true, positions: Array.isArray(data) ? (data as AlpacaPosition[]) : [] };
  } catch (e: any) {
    console.error("List positions error:", e);
    return { ok: false, positions: [], error: e?.message || "List positions request failed" };
  }
}

async function submitMarketOrder(symbol: string, side: "buy" | "sell", qty: number) {
  const body = { symbol, qty, side, type: "market", time_in_force: "day" };
  const r = await alpacaFetch("/v2/orders", { method: "POST", body: JSON.stringify(body) });
  const text = await r.text().catch(() => "");
  if (!r.ok) {
    console.error("Order failed:", r.status, text);
    throw new Error(text || `Order ${side} ${qty} ${symbol} failed (${r.status})`);
  }
  try { return JSON.parse(text); } catch { return {}; }
}

export async function POST(req: Request) {
  try {
    const { key } = await req.json().catch(() => ({}));
    if (!key || String(key) !== PANIC_PASSKEY) {
      return json({ ok: false, error: "Invalid passkey." }, 401);
    }

    if (!ALPACA_KEY || !ALPACA_SECRET) {
      return json({ ok: false, error: "Missing Alpaca credentials (key/secret)." }, 500);
    }

    const cancelRes = await cancelAllOpenOrders();

    const posRes = await listPositions();
    if (!posRes.ok) {
      return json({ ok: false, error: posRes.error || "Failed to fetch positions." }, 502);
    }

    const positions = posRes.positions || [];
    if (positions.length === 0) {
      return json({ ok: true, closed: [], note: "No open positions." });
    }

    const closed: Array<{ symbol: string; side: "buy" | "sell"; qty: number; orderId?: string }> = [];
    const errors: Array<{ symbol: string; err: string }> = [];

    for (const p of positions) {
      const symbol = p.symbol;
      const rawQty = Number(p.qty);
      if (!Number.isFinite(rawQty) || rawQty === 0) continue;
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
    return json({
      ok,
      canceledOpenOrders: cancelRes.ok ?? false,
      closed,
      errors,
    }, ok ? 200 : 207);
  } catch (err: any) {
    console.error("panic-sell route error:", err);
    return json({ ok: false, error: err?.message || "panic-sell failed" }, 500);
  }
}
