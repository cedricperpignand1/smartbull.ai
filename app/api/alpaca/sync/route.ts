// app/api/alpaca/sync/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { nowET } from "@/lib/market";

/** ───────────────── Authorization ─────────────────
 * Allows: Vercel Cron (headers), or manual with ?token=ALPACA_WEBHOOK_SECRET.
 */
function authorized(req: Request) {
  const h = req.headers;

  // Official Vercel Cron header
  if (h.get("x-vercel-cron") === "1") return true;

  // Occasionally present on Vercel cron runs
  if (h.get("x-vercel-signature")) return true;

  // "Run" button on dashboard
  const ua = (h.get("user-agent") || "").toLowerCase();
  if (ua.includes("vercel") && ua.includes("cron")) return true;

  // Manual / local: ?token=ALPACA_WEBHOOK_SECRET
  const SECRET = process.env.ALPACA_WEBHOOK_SECRET?.trim();
  if (!SECRET) return true; // dev convenience
  const u = new URL(req.url);
  return u.searchParams.get("token") === SECRET;
}

/** ───────────────── Alpaca client (consistent envs) ───────────────── */
const RAW_BASE = (process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets").trim();
// normalize: no trailing slash, no trailing /v2 (we add /v2 in paths below)
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

async function alpGet(
  path: string,
  qs?: Record<string, string | number | boolean | undefined | null>
) {
  const url = new URL(`${BASE}${path.startsWith("/") ? "" : "/"}${path}`);
  for (const [k, v] of Object.entries(qs || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url.toString(), {
    headers: {
      "APCA-API-KEY-ID": KEY,
      "APCA-API-SECRET-KEY": SEC,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
  if (!r.ok) {
    const msg = json?.message || json?.error || text || `HTTP ${r.status}`;
    throw new Error(`Alpaca GET ${path} ${r.status}: ${msg}`);
  }
  return json;
}

/** ───────────────── Types & helpers ───────────────── */
type AlpOrder = {
  id: string;
  client_order_id?: string;
  symbol: string;
  side: "buy" | "sell" | "unknown";
  status: string;
  qty?: number | null;
  filled_qty?: number | null;
  filled_avg_price?: number | null;
  filled_at?: string | null;
  submitted_at?: string | null;
  order_class?: string | null;
  legs?: AlpOrder[] | null;
};

function numOrNull(x: any): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function norm(o: any): AlpOrder {
  const rawSide = String(o?.side ?? "").toLowerCase();
  const side: "buy" | "sell" | "unknown" =
    rawSide === "buy" ? "buy" : rawSide === "sell" ? "sell" : "unknown";
  return {
    id: String(o?.id ?? ""),
    client_order_id: o?.client_order_id ?? o?.client_orderId ?? undefined,
    symbol: String(o?.symbol ?? "").toUpperCase(),
    side,
    status: String(o?.status ?? "").toLowerCase(),
    qty: numOrNull(o?.qty ?? o?.quantity),
    filled_qty: numOrNull(o?.filled_qty),
    filled_avg_price: numOrNull(o?.filled_avg_price ?? o?.avg_price),
    filled_at: o?.filled_at ?? null,
    submitted_at: o?.submitted_at ?? null,
    order_class: o?.order_class ?? null,
    legs: Array.isArray(o?.legs) ? o.legs.map(norm) : null,
  };
}

/** Ensure bot state exists (for cash/PnL/equity updates). */
async function ensureBotState() {
  let s = await prisma.botState.findUnique({ where: { id: 1 } });
  if (!s) {
    s = await prisma.botState.create({
      data: { id: 1, cash: 4000, pnl: 0, equity: 4000 },
    });
  }
  return s;
}

/** ───────────────── Apply BUY fill ─────────────────
 * - Reconciles cash if our assumed entry differs from actual fill.
 * - Updates/creates BUY trade with filledAt/filledPrice.
 * - Ensures position has the true entryPrice and brokerOrderId.
 */
async function applyBuyFill(o: AlpOrder) {
  if (o.side !== "buy") return;
  const ticker = o.symbol;
  if (!ticker) return;

  const filledAvg = o.filled_avg_price ?? null;
  const filledAt = o.filled_at ? new Date(o.filled_at) : nowET();

  await ensureBotState();

  // Prefer a position we created at submit; fallback to most recent open with same ticker
  let pos = await prisma.position.findFirst({
    where: { OR: [{ brokerOrderId: o.id }, { open: true, ticker }] },
    orderBy: { id: "desc" },
  });

  const sharesFilled = o.filled_qty ?? o.qty ?? null;

  // If somehow missing, create a position so UI stays consistent
  if (!pos && sharesFilled && filledAvg) {
    pos = await prisma.position.create({
      data: {
        ticker,
        entryPrice: filledAvg,
        shares: Math.floor(sharesFilled),
        open: true,
        brokerOrderId: o.id,
      },
    });
  }
  if (!pos) return; // nothing to do if we still can't resolve a position

  // The BUY trade we inserted on submit (or not)
  let buyTrade = await prisma.trade.findFirst({
    where: { side: "BUY", brokerOrderId: o.id },
    orderBy: { id: "desc" },
  });

  const entryAssumed = Number(pos.entryPrice);
  const shares = Number(pos.shares);
  const fillPx = filledAvg ?? entryAssumed;

  // Reconcile cash if our assumed price differs from actual fill (one-time)
  if (buyTrade && !buyTrade.filledAt && Number.isFinite(entryAssumed) && Number.isFinite(fillPx)) {
    const delta = shares * entryAssumed - shares * fillPx; // positive if fill better than assumed
    if (delta !== 0) {
      const st = await ensureBotState();
      await prisma.botState.update({
        where: { id: 1 },
        data: {
          cash:   Number(st.cash) + delta,
          equity: Number(st.equity) + delta,
        },
      });
    }
  }

  // Update position to true fill price and ensure brokerOrderId is mapped
  await prisma.position.update({
    where: { id: pos.id },
    data: { entryPrice: fillPx, brokerOrderId: (pos as any).brokerOrderId ?? o.id },
  });

  // Stamp or create the BUY trade
  if (buyTrade) {
    await prisma.trade.update({
      where: { id: buyTrade.id },
      data: { price: fillPx, filledAt, filledPrice: fillPx },
    });
  } else {
    await prisma.trade.create({
      data: {
        side: "BUY",
        ticker,
        price: fillPx,
        shares,
        brokerOrderId: o.id,
        filledAt,
        filledPrice: fillPx,
      },
    });
  }
}

/** ───────────────── Apply SELL fill ─────────────────
 * - Closes the position, records SELL trade, and updates cash/PnL/equity.
 * - Works for TP/SL child legs or manual market close.
 */
async function applySellFill(o: AlpOrder) {
  if (o.side !== "sell") return;
  const ticker = o.symbol;
  if (!ticker) return;

  // find open position
  const pos = await prisma.position.findFirst({
    where: { open: true, ticker },
    orderBy: { id: "desc" },
  });
  if (!pos) return;

  const shares = Number(pos.shares);
  const entry  = Number(pos.entryPrice);
  const fillPx = o.filled_avg_price ?? entry;
  const filledAt = o.filled_at ? new Date(o.filled_at) : nowET();

  const exitVal  = shares * fillPx;
  const entryVal = shares * entry;
  const realized = exitVal - entryVal;

  // Close position
  await prisma.position.update({
    where: { id: pos.id },
    data: { open: false, exitPrice: fillPx, exitAt: filledAt },
  });

  // Create SELL trade if not present
  const existingSell = await prisma.trade.findFirst({
    where: { side: "SELL", brokerOrderId: o.id },
    orderBy: { id: "desc" },
  });
  if (!existingSell) {
    await prisma.trade.create({
      data: {
        side: "SELL",
        ticker,
        price: fillPx,
        shares,
        brokerOrderId: o.id,
        filledAt,
        filledPrice: fillPx,
      },
    });
  }

  // Update state
  const st = await ensureBotState();
  const newCash = Number(st.cash) + exitVal;
  const newPnl  = Number(st.pnl) + realized;

  await prisma.botState.update({
    where: { id: 1 },
    data: {
      cash:   newCash,
      pnl:    newPnl,
      equity: newCash, // no open pos left for this symbol; if multiple symbols, equity will be refreshed by tick route
    },
  });
}

/** ───────────────── Sync recent orders ─────────────────
 * Pulls recent orders (parents + TP/SL legs), flattens, and mirrors fills.
 */
async function syncRecentOrders() {
  // Pull last 90 minutes; adjust if you want more/less history
  const afterISO = new Date(Date.now() - 90 * 60 * 1000).toISOString();

  // status=all & nested=true brings bracket legs along
  const ordersRaw = await alpGet("/v2/orders", {
    status: "all",
    limit: 200,
    nested: true,
    after: afterISO,
    direction: "desc",
  });

  const parents: AlpOrder[] = Array.isArray(ordersRaw) ? ordersRaw.map(norm) : [];
  const flat: AlpOrder[] = [];
  for (const o of parents) {
    flat.push(o);
    if (Array.isArray(o.legs)) for (const l of o.legs) flat.push(l);
  }

  let processed = 0;
  for (const o of flat) {
    // treat as filled if status says filled OR we have a filled_avg_price
    const isFilled =
      (o.status && o.status.includes("filled")) ||
      (o.filled_qty && (o.filled_qty ?? 0) > 0 && o.filled_avg_price != null);

    if (!isFilled) continue;

    if (o.side === "buy") {
      await applyBuyFill(o);
      processed++;
    } else if (o.side === "sell") {
      await applySellFill(o);
      processed++;
    }
  }

  return { checked: flat.length, processed, afterISO };
}

/** ───────────────── Handlers ───────────────── */
export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const res = await syncRecentOrders();
    return NextResponse.json({ ok: true, base: BASE, ...res });
  } catch (e: any) {
    console.error("[alpaca-sync] error", e?.message || e);
    return NextResponse.json({ ok: false, error: e?.message || "sync_error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return GET(req);
}
