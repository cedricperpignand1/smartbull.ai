// app/api/alpaca/webhook/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { nowET } from "@/lib/market";

/** Accept ?token=SECRET or header x-webhook-secret: SECRET */
function authorized(req: Request) {
  const SECRET = process.env.ALPACA_WEBHOOK_SECRET?.trim();
  if (!SECRET) return true; // dev only
  const url = new URL(req.url);
  if (url.searchParams.get("token") === SECRET) return true;
  const hdr = req.headers.get("x-webhook-secret");
  return hdr === SECRET;
}

function pickOrder(payload: any) {
  const o = payload?.order ?? payload?.data?.order ?? payload;
  return {
    id:         o?.id ?? o?.order_id ?? null,
    client_id:  o?.client_order_id ?? o?.client_id ?? null,
    symbol:     String(o?.symbol ?? "").toUpperCase(),
    side:       String(o?.side ?? "").toLowerCase(), // 'buy' | 'sell'
    status:     String(payload?.event ?? payload?.status ?? payload?.data?.event ?? o?.status ?? "").toLowerCase(),
    qty:        Number(o?.qty ?? o?.quantity ?? 0),
    filled_qty: Number(o?.filled_qty ?? 0),
    filled_avg: (o?.filled_avg_price != null) ? Number(o.filled_avg_price) :
                (o?.avg_price != null ? Number(o.avg_price) : null),
    order_class: String(o?.order_class ?? "").toLowerCase(),
    legs:       Array.isArray(o?.legs) ? o.legs : [],
  };
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let payload: any;
  try { payload = raw ? JSON.parse(raw) : {}; }
  catch { return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 }); }

  const o = pickOrder(payload);
  if (!o?.id || !o?.symbol || !o?.side) {
    return NextResponse.json({ ok: true, note: "ignored: missing fields" });
  }

  const isFill = o.status.includes("fill"); // 'filled' or 'partial_fill'
  if (!isFill) {
    return NextResponse.json({ ok: true, note: `no-op status=${o.status}` });
  }

  try {
    // Ensure bot state exists
    let state = await prisma.botState.findUnique({ where: { id: 1 } });
    if (!state) {
      state = await prisma.botState.create({ data: { id: 1, cash: 4000, pnl: 0, equity: 4000 } });
    }

    if (o.side === "buy") {
      // Find local position mapped to this order (or open position for symbol)
      let pos = await prisma.position.findFirst({
        where: { OR: [{ brokerOrderId: o.id }, { open: true, ticker: o.symbol }] },
        orderBy: { id: "desc" },
      });
      if (!pos) {
        return NextResponse.json({ ok: true, note: "buy fill without local position — ignored" });
      }

      // Find any existing BUY trade for this order
      const buyTrade = await prisma.trade.findFirst({
        where: { side: "BUY", brokerOrderId: o.id },
        orderBy: { id: "desc" },
      });

      const filledPrice = (o.filled_avg && Number.isFinite(o.filled_avg))
        ? o.filled_avg
        : Number(pos.entryPrice);
      const prevEntry = Number(pos.entryPrice);
      const shares    = Number(pos.shares);

      const alreadyStamped = !!buyTrade?.filledAt;

      // Reconcile cash/equity if assumed entry != actual fill
      if (!alreadyStamped && Number.isFinite(prevEntry) && Number.isFinite(filledPrice)) {
        const delta = shares * prevEntry - shares * filledPrice; // positive if fill was better
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

      // Update position with real fill & ensure brokerOrderId stored
      pos = await prisma.position.update({
        where: { id: pos.id },
        data: { entryPrice: filledPrice, open: true, brokerOrderId: (pos as any).brokerOrderId ?? o.id },
      });

      // Stamp trade fill (create if missing)
      if (buyTrade) {
        await prisma.trade.update({
          where: { id: buyTrade.id },
          data: { price: filledPrice, filledAt: nowET(), filledPrice: filledPrice },
        });
      } else {
        await prisma.trade.create({
          data: {
            side: "BUY",
            ticker: o.symbol,
            price: filledPrice,
            shares,
            brokerOrderId: o.id,
            filledAt: nowET(),
            filledPrice: filledPrice,
          },
        });
      }

      return NextResponse.json({ ok: true, action: "buy_fill_updated", positionId: pos.id });
    }

    if (o.side === "sell") {
      const pos = await prisma.position.findFirst({
        where: { open: true, ticker: o.symbol },
        orderBy: { id: "desc" },
      });
      if (!pos) {
        return NextResponse.json({ ok: true, note: "sell fill but no open position — already closed" });
      }

      const shares = Number(pos.shares);
      const entry  = Number(pos.entryPrice);
      const fillPx = (o.filled_avg && Number.isFinite(o.filled_avg)) ? o.filled_avg : entry;

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
            ticker: pos.ticker,
            price: fillPx,
            shares,
            brokerOrderId: o.id,
            filledAt: nowET(),
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

      return NextResponse.json({ ok: true, action: "sell_fill_closed", realized });
    }

    return NextResponse.json({ ok: true, note: `ignored side=${o.side}` });
  } catch (e: any) {
    console.error("[alpaca-webhook] error", e?.message || e);
    return NextResponse.json({ ok: false, error: e?.message || "server_error" }, { status: 500 });
  }
}
