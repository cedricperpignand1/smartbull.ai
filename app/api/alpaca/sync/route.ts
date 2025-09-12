export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
// If you have nowET in "@/lib/market" keep it; otherwise use local fallback:
import { nowET as _nowET } from "@/lib/market";

const nowET: () => Date =
  typeof _nowET === "function"
    ? _nowET
    : () => new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));

/* ─────────── Authorization ─────────── */
function authorized(req: Request) {
  const h = req.headers;

  if (h.get("x-vercel-cron") === "1") return true;
  if (h.get("x-vercel-signature")) return true;

  const ua = (h.get("user-agent") || "").toLowerCase();
  if (ua.includes("vercel") && ua.includes("cron")) return true;

  const SECRET = process.env.ALPACA_WEBHOOK_SECRET?.trim();
  if (!SECRET) return true;
  const u = new URL(req.url);
  return u.searchParams.get("token") === SECRET;
}

/* ─────────── Alpaca client ─────────── */
const RAW_BASE = (process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets").trim();
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
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!r.ok) {
    const msg = json?.message || json?.error || text || `HTTP ${r.status}`;
    throw new Error(`Alpaca GET ${path} ${r.status}: ${msg}`);
  }
  return json;
}

/* ─────────── Types / helpers ─────────── */
type AlpOrder = {
  id: string;
  client_order_id?: string;
  symbol: string;
  side: "buy" | "sell" | "unknown";
  status: string; // lower-case
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

function startOfETDayISO(isoLike?: string) {
  const base = isoLike ? new Date(isoLike) : new Date();
  const d = new Date(base.toLocaleString("en-US", { timeZone: "America/New_York" }));
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

async function ensureBotState() {
  let s = await prisma.botState.findUnique({ where: { id: 1 } });
  if (!s) {
    s = await prisma.botState.create({ data: { id: 1, cash: 4000, pnl: 0, equity: 4000 } });
  }
  return s;
}

/* ─────────── BUY fill ─────────── */
async function applyBuyFill(o: AlpOrder) {
  if (o.side !== "buy") return;
  const ticker = o.symbol;
  if (!ticker) return;

  const filledAvg = o.filled_avg_price ?? null;
  const filledAt = o.filled_at ? new Date(o.filled_at) : nowET();
  await ensureBotState();

  // Prefer matching brokerOrderId, else open pos of same ticker
  let pos = await prisma.position.findFirst({
    where: { OR: [{ brokerOrderId: o.id }, { open: true, ticker }] },
    orderBy: { id: "desc" },
  });

  const sharesFilled = o.filled_qty ?? o.qty ?? null;

  // Create missing position if needed
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
  if (!pos) return;

  const entryAssumed = Number(pos.entryPrice);
  const shares = Number(pos.shares);
  const fillPx = filledAvg ?? entryAssumed;

  // Reconcile cash if our assumed entry != actual fill
  const buyTrade = await prisma.trade.findFirst({
    where: { side: "BUY", brokerOrderId: o.id },
    orderBy: { id: "desc" },
  });

  if (buyTrade && !buyTrade.filledAt && Number.isFinite(entryAssumed) && Number.isFinite(fillPx)) {
    const delta = shares * entryAssumed - shares * fillPx;
    if (delta !== 0) {
      const st = await ensureBotState();
      await prisma.botState.update({
        where: { id: 1 },
        data: { cash: Number(st.cash) + delta, equity: Number(st.equity) + delta },
      });
    }
  }

  // Update position entry price & link brokerOrderId
  await prisma.position.update({
    where: { id: pos.id },
    data: { entryPrice: fillPx, brokerOrderId: (pos as any).brokerOrderId ?? o.id },
  });

  // Stamp or create BUY trade
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

/* ─────────── SELL fill (handles partials) ─────────── */
async function applySellFill(o: AlpOrder) {
  if (o.side !== "sell") return;
  const ticker = o.symbol;
  if (!ticker) return;

  // Match by brokerOrderId OR latest open position on ticker
  let pos = await prisma.position.findFirst({
    where: { OR: [{ brokerOrderId: o.id }, { open: true, ticker }] },
    orderBy: { id: "desc" },
  });
  if (!pos) return;

  const sharesPos = Number(pos.shares);
  if (!Number.isFinite(sharesPos) || sharesPos === 0) return;

  const qtyFilled = Number(o.filled_qty ?? o.qty ?? sharesPos);
  const filledAt = o.filled_at ? new Date(o.filled_at) : nowET();

  // If Alpaca didn’t give avg price (can happen on legs), fall back to position entry to at least log it
  const fillPx = Number(
    o.filled_avg_price ?? (Array.isArray(o.legs) ? o.legs[0]?.filled_avg_price : undefined) ?? pos.exitPrice ?? pos.entryPrice
  );

  const entry = Number(pos.entryPrice);
  const sellQty = Math.min(qtyFilled, sharesPos);
  const realized = (fillPx - entry) * sellQty;

  // Upsert SELL trade for this broker leg (id-based)
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
        shares: sellQty,
        brokerOrderId: o.id,
        filledAt,
        filledPrice: fillPx,
      },
    });
  } else {
    // ensure it’s stamped
    await prisma.trade.update({
      where: { id: existingSell.id },
      data: { price: fillPx, shares: sellQty, filledAt, filledPrice: fillPx },
    });
  }

  // Update bot state cash/pnl/equity
  const st = await ensureBotState();
  const exitVal = sellQty * fillPx;
  const newCash = Number(st.cash) + exitVal;
  const newPnl = Number(st.pnl) + realized;

  await prisma.botState.update({
    where: { id: 1 },
    data: { cash: newCash, pnl: newPnl, equity: newCash },
  });

  // Close or reduce position
  if (sellQty >= sharesPos) {
    await prisma.position.update({
      where: { id: pos.id },
      data: { open: false, exitPrice: fillPx, exitAt: filledAt, shares: 0 },
    });
  } else {
    await prisma.position.update({
      where: { id: pos.id },
      data: { shares: sharesPos - sellQty },
    });
  }
}

/* ─────────── Sync recent orders ─────────── */
async function syncRecentOrders(afterISO: string, untilISO?: string) {
  const ordersRaw = await alpGet("/v2/orders", {
    status: "all",
    limit: 200,
    nested: true,
    after: afterISO,
    ...(untilISO ? { until: untilISO } : {}),
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
    // Robust filled detection:
    //  - status 'filled' or 'partially_filled'
    //  - OR any positive filled_qty
    //  - OR presence of filled_at
    const isFilled =
      o.status.includes("filled") ||
      o.status.includes("partially_filled") ||
      (o.filled_qty ?? 0) > 0 ||
      !!o.filled_at;

    if (!isFilled) continue;

    if (o.side === "buy") {
      await applyBuyFill(o);
      processed++;
    } else if (o.side === "sell") {
      await applySellFill(o);
      processed++;
    }
  }

  return { checked: flat.length, processed, afterISO, untilISO: untilISO || null };
}

/* ─────────── Handlers ─────────── */
export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const u = new URL(req.url);

    // Accept either a rolling window OR a whole day
    const day = u.searchParams.get("day"); // e.g. "2025-08-27" (ET day)
    let afterISO: string;

    if (day) {
      afterISO = startOfETDayISO(`${day}T00:00:00Z`);
    } else {
      const wm = Math.max(15, Math.min(1440 * 7, Number(u.searchParams.get("windowMinutes") ?? "90")));
      afterISO = new Date(Date.now() - wm * 60 * 1000).toISOString();
    }

    const untilISO = u.searchParams.get("until") || undefined;
    const res = await syncRecentOrders(afterISO, untilISO);

    const keyLast4 = KEY ? KEY.slice(-4) : "";
    return NextResponse.json({ ok: true, base: BASE, keyLast4, ...res });
  } catch (e: any) {
    console.error("[alpaca-sync] error", e?.message || e);
    return NextResponse.json({ ok: false, error: e?.message || "sync_error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  // mirror GET
  return GET(req);
}
