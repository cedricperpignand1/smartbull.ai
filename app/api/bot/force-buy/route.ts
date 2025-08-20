// app/api/bot/force-buy/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getQuote } from "@/lib/quote";
import { isWeekdayET, isMarketHoursET, yyyyMmDdET } from "@/lib/market";
import { submitBracketBuy } from "@/lib/alpaca";

const INVEST_BUDGET = 4000;
const TARGET_PCT = 0.10;
const STOP_PCT   = -0.05;
const TOP_CANDIDATES = 8;

type SnapStock = { ticker: string; price?: number | null };

// Build base URL for calling sibling APIs
function getBaseUrl(req: Request) {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = (req.headers.get("x-forwarded-proto") || "http").split(",")[0].trim();
  const host  = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

// Snapshot helper
async function getSnapshot(baseUrl: string) {
  try {
    const r = await fetch(`${baseUrl}/api/stocks/snapshot`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    const stocks = Array.isArray(j?.stocks) ? j.stocks : [];
    return { stocks, updatedAt: j?.updatedAt || new Date().toISOString() };
  } catch { return null; }
}

// Robust AI pick parser
function parseAIPick(rJson: any): string | null {
  // 1) Direct JSON fields
  const fields = [
    rJson?.ticker,
    rJson?.symbol,
    rJson?.pick,
    rJson?.Pick,
    rJson?.data?.ticker,
    rJson?.data?.symbol,
  ];
  for (const f of fields) {
    if (typeof f === "string" && /^[A-Za-z][A-Za-z0-9.\-]*$/.test(f)) {
      return f.toUpperCase();
    }
  }
  // 2) Context array: { context: { tickers: [ { ticker: "TRIB" } ] } }
  const ctxTicker = rJson?.context?.tickers?.[0]?.ticker;
  if (typeof ctxTicker === "string" && /^[A-Za-z][A-Za-z0-9.\-]*$/.test(ctxTicker)) {
    return ctxTicker.toUpperCase();
  }
  // 3) Free text / markdown: "**Pick:** TRIB" or "Pick: TRIB" / "Pick - TRIB"
  let txt = String(rJson?.recommendation ?? rJson?.text ?? rJson?.message ?? "");
  txt = txt.replace(/[*_`~]/g, "").replace(/^-+\s*/gm, ""); // strip markdown/bullets
  const m1 = /Pick\s*:?\s*([A-Z][A-Z0-9.\-]*)/i.exec(txt);
  const m2 = /Pick\s*[-–—]\s*([A-Z][A-Z0-9.\-]*)/i.exec(txt);
  const sym = (m1?.[1] || m2?.[1])?.toUpperCase();
  return sym || null;
}

export async function POST(req: Request) {
  const debug: any = { reasons: [] as string[] };

  try {
    // Gates
    if (!isWeekdayET()) {
      return NextResponse.json({ ok: false, reason: "not_weekday" }, { status: 400 });
    }
    if (!isMarketHoursET()) {
      return NextResponse.json({ ok: false, reason: "market_closed" }, { status: 400 });
    }

    // Ensure state
    let state = await prisma.botState.findUnique({ where: { id: 1 } });
    if (!state) state = await prisma.botState.create({ data: { id: 1, cash: 4000, pnl: 0, equity: 4000 } });

    // No open position
    const openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
    if (openPos) {
      return NextResponse.json({ ok: false, reason: "position_already_open", openPos }, { status: 400 });
    }

    // Candidates from snapshot
    const base = getBaseUrl(req);
    const snapshot = await getSnapshot(base);
    const top = (snapshot?.stocks || []).slice(0, TOP_CANDIDATES) as SnapStock[];
    if (!top.length) {
      return NextResponse.json({ ok: false, reason: "snapshot_empty" }, { status: 400 });
    }

    // Prefer affordable to avoid shares=0
    const affordable = top.filter(s => Number.isFinite(Number(s.price)) && Number(s.price) <= INVEST_BUDGET);
    const candidates = affordable.length ? affordable : top;
    debug.candidates = candidates.map(c => `${c.ticker}${c.price ? `@${Number(c.price).toFixed(2)}` : ""}`);

    // Ask AI to pick from candidates
    const rRes = await fetch(`${base}/api/recommendation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stocks: candidates, forcePick: true, requirePick: true }),
      cache: "no-store",
    });
    if (!rRes.ok) {
      return NextResponse.json({ ok: false, reason: "recommendation_http_error", status: rRes.status }, { status: 400 });
    }
    const rJson = await rRes.json();
    const ticker = parseAIPick(rJson);
    if (!ticker) {
      return NextResponse.json({ ok: false, reason: "ai_no_pick", raw: rJson }, { status: 400 });
    }

    // Price reference (snapshot -> live quote)
    const snapPrice = candidates.find(s => s.ticker === ticker)?.price;
    const ref0 = snapPrice ?? (await getQuote(ticker));
    if (ref0 == null || !Number.isFinite(Number(ref0))) {
      return NextResponse.json({ ok: false, reason: "no_price_for_entry", ticker }, { status: 400 });
    }
    const ref = Number(ref0);

    // Claim daily lock (same as scheduled flow)
    const today = yyyyMmDdET();
    const claim = await prisma.botState.updateMany({
      where: { id: 1, OR: [{ lastRunDay: null }, { lastRunDay: { not: today } }] },
      data: { lastRunDay: today },
    });
    if (claim.count !== 1) {
      return NextResponse.json({ ok: false, reason: "day_lock_already_claimed" }, { status: 400 });
    }

    // Re-check position after claiming
    const stillOpen = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
    if (stillOpen) {
      return NextResponse.json({ ok: false, reason: "position_open_after_claim" }, { status: 400 });
    }

    // Compute shares & bracket levels
    const cashNum = Number(state.cash);
    const shares = Math.floor(Math.min(cashNum, INVEST_BUDGET) / ref);
    if (shares <= 0) {
      // release lock so you can retry
      await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
      return NextResponse.json({ ok: false, reason: "insufficient_cash_for_one_share", ref, cash: cashNum }, { status: 400 });
    }

    const tp = ref * (1 + TARGET_PCT);
    const sl = ref * (1 + STOP_PCT);

    try {
      // MARKET bracket buy (fills immediately in regular hours)
      const order = await submitBracketBuy({
        symbol: ticker,
        qty: shares,
        entryType: "market",
        tp,
        sl,
        tif: "day",
      });

      const pos = await prisma.position.create({
        data: { ticker, entryPrice: ref, shares, open: true, brokerOrderId: order.id },
      });

      await prisma.trade.create({
        data: { side: "BUY", ticker, price: ref, shares, brokerOrderId: order.id },
      });

      const newCash = cashNum - shares * ref;
      await prisma.botState.update({
        where: { id: 1 },
        data: { cash: newCash, equity: newCash + shares * ref },
      });

      return NextResponse.json({
        ok: true,
        message: `BUY ${ticker} @ ~${ref.toFixed(2)} (shares=${shares})`,
        orderId: order.id,
        position: pos,
      });
    } catch (e: any) {
      // Release lock so you can retry
      await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
      const msg = e?.message || "unknown";
      const body = e?.body ? JSON.stringify(e.body).slice(0, 400) : null;
      return NextResponse.json({ ok: false, reason: "alpaca_submit_failed", error: msg, body, debug }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: false, error: "Use POST" }, { status: 405 });
}
