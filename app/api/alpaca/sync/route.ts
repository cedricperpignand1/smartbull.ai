// app/api/alpaca/sync/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { nowET } from "@/lib/market";

/** Protect the endpoint with ?token=ALPACA_WEBHOOK_SECRET */
function authorized(req: Request) {
  const SECRET = process.env.ALPACA_WEBHOOK_SECRET?.trim();
  if (!SECRET) return true; // dev OK
  const u = new URL(req.url);
  return u.searchParams.get("token") === SECRET;
}

const ALP = (process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets/v2").replace(/\/+$/, "");

async function alpGet(path: string, qs?: Record<string, string | number | undefined>) {
  const url = new URL(ALP + path);
  for (const [k, v] of Object.entries(qs || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url.toString(), {
    headers: {
      "APCA-API-KEY-ID": process.env.ALPACA_API_KEY || "",
      "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY || "",
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Alpaca GET ${path} ${r.status}: ${txt}`);
  }
  return r.json();
}

type AlpOrder = {
  id: string;
  client_order_id?: string;
  symbol: string;
  side: "buy" | "sell" | "unknown";   // ← patched
  status: string;
  qty?: string | number;
  filled_qty?: string | number;
  filled_avg_price?: string | number | null;
  filled_at?: string | null;
  submitted_at?: string | null;
  legs?: AlpOrder[] | null;
  order_class?: string | null;
};

/** Normalize one order safely */
function norm(o: any): AlpOrder {
  const rawSide = String(o?.side ?? "").toLowerCase();
  const side: "buy" | "sell" | "unknown" =
    rawSide === "buy" ? "buy" :
    rawSide === "sell" ? "sell" : "unknown";

  return {
    id: String(o?.id),
    client_order_id: o?.client_order_id ?? o?.client_orderId ?? undefined,
    symbol: String(o?.symbol ?? "").toUpperCase(),
    side,
    status: String(o?.status ?? "").toLowerCase(),
    qty: (o?.qty ?? o?.quantity) ?? undefined,
    filled_qty: o?.filled_qty ?? undefined,
    filled_avg_price: o?.filled_avg_price ?? o?.avg_price ?? null,
    filled_at: o?.filled_at ?? null,
    submitted_at: o?.submitted_at ?? null,
    order_class: o?.order_class ?? null,
    legs: Array.isArray(o?.legs) ? o.legs : null,
  };
}

/** Handle a filled BUY: stamp fill & reconcile cash if price differs */
async function applyBuyFill(o: AlpOrder) {
  if (o.side !== "buy") return;
  const ticker = o.symbol;
  if (!ticker) return;

  const filledAvg = o.filled_avg_price != null ? Number(o.filled_avg_price) : null;
  const filledAt = o.filled_at ? new Date(o.filled_at) : nowET();

  // Ensure bot state exists
  let state = await prisma.botState.findUnique({ where: { id: 1 } });
  if (!state) {
    state = await prisma.botState.create({ data: { id: 1, cash: 4000, pnl: 0, equity: 4000 } });
  }

  // Find position created at submit time
  let pos = await prisma.position.findFirst({
    where: { OR: [{ brokerOrderId: o.id }, { open: true, ticker }] },
    orderBy: { id: "desc" },
  });
  if (!pos) return;

  const buyTrade = await prisma.trade.findFirst({
    where: { side: "BUY", brokerOrderId: o.id },
    orderBy: { id: "desc" },
  });

  const entryAssumed = Number(pos.entryPrice);
  const shares = Number(pos.shares);
  const fillPx = Number.isFinite(filledAvg as number) ? (filledAvg as number) : entryAssumed;

  // If our assumed limit differs from actual fill, reconcile cash/equity once
  if (buyTrade && !buyTrade.filledAt && Number.isFinite(entryAssumed) && Number.isFinite(fillPx)) {
    const delta = shares * entryAssumed - shares * fillPx; // positive if fill better
    if (delta !== 0) {
      await prisma.botState.update({
        where: { id: 1 },
        data: {
          cash:   Number(state.cash) + delta,
          equity: Number(state.equity) + delta,
        },
      });
      state = (await prisma.botState.findUnique({ where: { id: 1 } }))!;
    }
  }

  // Update position with true fill & map brokerOrderId if missing
  await prisma.position.update({
    where: { id: pos.id },
    data: { entryPrice: fillPx, brokerOrderId: (pos as any).brokerOrderId ?? o.id },
  });

  // Stamp BUY trade (or create if was missing)
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

/** Handle a filled SELL (TP/SL child or time-based exit) */
async function applySellFill(o: AlpOrder) {
  if (o.side !== "sell") return;
  const ticker = o.symbol;
  if (!ticker) return;

  const pos = await prisma.position.findFirst({
    where: { open: true, ticker },
    orderBy: { id: "desc" },
  });
  if (!pos) return;

  const shares = Number(pos.shares);
  const entry  = Number(pos.entryPrice);
  const fillPx = o.filled_avg_price != null ? Number(o.filled_avg_price) : entry;

  const exitVal  = shares * fillPx;
  const entryVal = shares * entry;
  const realized = exitVal - entryVal;

  await prisma.position.update({
    where: { id: pos.id },
    data: { open: false, exitPrice: fillPx, exitAt: nowET() },
  });

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
        filledAt: o.filled_at ? new Date(o.filled_at) : nowET(),
        filledPrice: fillPx,
      },
    });
  }

  const fresh = await prisma.botState.findUnique({ where: { id: 1 } });
  const freshCash = Number(fresh?.cash ?? 0);
  const freshPnl  = Number(fresh?.pnl ?? 0);

  await prisma.botState.update({
    where: { id: 1 },
    data: {
      cash:   freshCash + exitVal,
      pnl:    freshPnl + realized,
      equity: freshCash + exitVal,
    },
  });
}

/** Pull recent orders and mirror fills into our DB */
async function syncRecentOrders() {
  // Pull last 90 minutes to cover trading window & late fills
  const afterISO = new Date(Date.now() - 90 * 60 * 1000).toISOString();

  // status=all and nested=true (to include TP/SL legs)
  const ordersRaw = await alpGet("/orders", {
    status: "all",
    limit: 200,
    nested: "true",
    after: afterISO,
    direction: "desc",
  });

  const orders: AlpOrder[] = Array.isArray(ordersRaw) ? ordersRaw.map(norm) : [];

  // Flatten parent + legs
  const flat: AlpOrder[] = [];
  for (const o of orders) {
    flat.push(o);
    if (Array.isArray(o.legs)) {
      for (const l of o.legs) flat.push(norm(l));
    }
  }

  for (const o of flat) {
    const isFilled =
      o.status.includes("filled") ||
      (o.filled_qty && Number(o.filled_qty) > 0 && o.filled_avg_price != null);

    if (!isFilled) continue;

    if (o.side === "buy") {
      await applyBuyFill(o);
    } else if (o.side === "sell") {
      await applySellFill(o);
    }
  }

  return { checked: flat.length, afterISO };
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const res = await syncRecentOrders();
    return NextResponse.json({ ok: true, ...res });
  } catch (e: any) {
    console.error("[alpaca-sync] error", e?.message || e);
    return NextResponse.json({ ok: false, error: e?.message || "sync_error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return GET(req);
}
