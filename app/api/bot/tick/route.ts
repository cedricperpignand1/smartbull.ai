import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client"; // for Decimal math
import { getQuote } from "@/lib/quote";
import {
  isWeekdayET,
  isMarketHoursET,
  is940ET,
  yyyyMmDdET,
  nowET,
} from "@/lib/market";

// Never cache this route
export const dynamic = "force-dynamic";
export const revalidate = 0;

const START_CASH = 4000;
const TP_PCT = 0.10;  // +10% take-profit
const SL_PCT = -0.05; // -5% stop-loss

async function ensureState() {
  let s = await prisma.botState.findUnique({ where: { id: 1 } });
  if (!s) {
    s = await prisma.botState.create({
      data: {
        id: 1,
        cash: START_CASH,
        pnl: 0,
        equity: START_CASH,
        paused: false, // default running
      },
    });
  }
  return s;
}

const getOpenPosition = () =>
  prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });

const getLastRecommendation = () =>
  prisma.recommendation.findFirst({ orderBy: { id: "desc" } });

async function askAIForTicker(): Promise<string | null> {
  const url = process.env.AI_PICK_URL;
  if (!url) return null;
  try {
    const r = await fetch(url, { method: "POST", cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    const t = (j?.ticker || "").toUpperCase().trim();
    return t || null;
  } catch {
    return null;
  }
}

export async function GET() { return handle(); }
export async function POST() { return handle(); }

async function handle() {
  // Ensure bot state exists
  let state = await ensureState();

  // ⛔ Respect Pause
  if (state.paused) {
    return NextResponse.json({
      state,
      lastRec: await getLastRecommendation(),
      position: await getOpenPosition(),
      live: null,
      serverTimeET: nowET().toISOString(),
      skipped: "paused",
    });
  }

  let openPos = await getOpenPosition();
  let lastRec = await getLastRecommendation();
  let livePrice: number | null = null;

  // If market closed, just return snapshot so UI can render
  if (!isWeekdayET() || !isMarketHoursET()) {
    return NextResponse.json({
      state,
      lastRec,
      position: openPos,
      live: null,
      serverTimeET: nowET().toISOString(),
      skipped: "market_closed",
    });
  }

  // Try to fetch a live price for whatever we're tracking
  const symbol = openPos?.ticker ?? lastRec?.ticker ?? null;
  if (symbol) livePrice = await getQuote(symbol);

  const today = yyyyMmDdET();
  const shouldRun = is940ET() && state.lastRunDay !== today;

  // --- 9:40 AM ET daily buy (all-in) ---
  if (shouldRun) {
    const ticker = await askAIForTicker();
    if (ticker) {
      const price = await getQuote(ticker);
      if (price != null) {
        // Record the recommendation with the exact price stamp
        lastRec = await prisma.recommendation.create({ data: { ticker, price } });

        // All-in buy based on current cash
        const cashNum = Number(state.cash);
        const shares = Math.floor(cashNum / price);

        if (shares > 0) {
          const used = shares * price;

          openPos = await prisma.position.create({
            data: { ticker, entryPrice: price, shares, open: true },
          });

          await prisma.trade.create({
            data: { side: "BUY", ticker, price, shares },
          });

          state = await prisma.botState.update({
            where: { id: 1 },
            data: {
              cash: cashNum - used,
              equity: cashNum - used + shares * price,
              lastRunDay: today,
            },
          });

          livePrice = price;
        } else {
          // Not enough to buy 1 share—still mark that we ran today
          await prisma.botState.update({
            where: { id: 1 },
            data: { lastRunDay: today },
          });
        }
      }
    }
  }

  // --- Manage open position (update equity; exit at SL/TP) ---
  if (openPos) {
    const p = livePrice ?? (await getQuote(openPos.ticker));
    if (p != null) {
      livePrice = p;

      const entry = Number(openPos.entryPrice);
      const change = (p - entry) / entry; // e.g. 0.05 = +5%
      const hitSL = change <= SL_PCT;
      const hitTP = change >= TP_PCT;

      // Keep equity fresh while the position is open
      const equityNow = Number(state.cash) + openPos.shares * p;
      if (Number(state.equity) !== equityNow) {
        state = await prisma.botState.update({
          where: { id: 1 },
          data: { equity: equityNow },
        });
      }

      // Exit on stop-loss or take-profit
      if (hitSL || hitTP) {
        const closedAt = nowET();

        await prisma.trade.create({
          data: { side: "SELL", ticker: openPos.ticker, price: p, shares: openPos.shares },
        });

        await prisma.position.update({
          where: { id: openPos.id },
          data: { open: false, exitPrice: p, exitAt: closedAt },
        });

        // --- NEW: Write a P&L row ---
        const invested = new Prisma.Decimal(openPos.entryPrice).mul(openPos.shares);
        const realized = new Prisma.Decimal(p).minus(openPos.entryPrice).mul(openPos.shares);

        await prisma.pnlEntry.create({
          data: {
            positionId: openPos.id,
            ticker: openPos.ticker,
            entryPrice: openPos.entryPrice,
            exitPrice: p,
            shares: openPos.shares,
            invested,
            realized,
            openedAt: openPos.entryAt,
            closedAt,
          },
        });

        // Update cash / pnl / equity totals
        const exitVal = openPos.shares * p;
        state = await prisma.botState.update({
          where: { id: 1 },
          data: {
            cash: Number(state.cash) + exitVal,
            pnl: new Prisma.Decimal(state.pnl).plus(realized),
            equity: Number(state.cash) + exitVal,
          },
        });

        openPos = null;
      }
    }
  }

  // Final payload for UI
  return NextResponse.json({
    state, // account snapshot
    lastRec, // last AI pick (ticker, price, at)
    position: openPos, // open position if any
    live: { ticker: openPos?.ticker ?? lastRec?.ticker ?? null, price: livePrice },
    serverTimeET: nowET().toISOString(),
  });
}
