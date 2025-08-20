// app/api/bot/tick/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getQuote } from "@/lib/quote";
import { isWeekdayET, isMarketHoursET, yyyyMmDdET, nowET } from "@/lib/market";
import { submitBracketBuy, closePositionMarket } from "@/lib/alpaca";

/** ───────────────── Throttle / Coalesce ───────────────── */
let lastTickAt = 0;
let lastTickResponse: any = null;
let pendingTick: Promise<any> | null = null;
const MIN_TICK_MS = 500;

/** ───────────────── Config ───────────────── */
const START_CASH = 4000;
const INVEST_BUDGET = 4000;     // cap per trade; if cash < 4k use all cash
const TARGET_PCT = 0.10;        // +10% TP
const STOP_PCT   = -0.05;       // -5% SL
const MAX_SLIPPAGE_PCT = 0.003; // +0.3% above ref price
const SNAPSHOT_STALE_MS = 7_500;
const TOP_CANDIDATES    = 8;

/** ───────────────── 10:45 ET Mandatory AI-Buy Window ───────────────── */
function isMandatoryAiBuyWindow1045ET() {
  const d = nowET();
  return d.getHours() === 10 && d.getMinutes() === 45;
}

/** ───────────────── Time Helpers ───────────────── */
function isMandatoryExitET() {
  const d = nowET();
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= (15 * 60 + 55); // 15:55+
}

/** ───────────────── Types & Helpers ───────────────── */
type SnapStock = {
  ticker: string;
  price?: number | null;
  changesPercentage?: number | null;
  volume?: number | null;
  avgVolume?: number | null;
  marketCap?: number | null;
};

function toET(dateIso: string) {
  return new Date(new Date(dateIso).toLocaleString("en-US", { timeZone: "America/New_York" }));
}
function isSameETDay(d: Date, ymd: string) {
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}` === ymd;
}

function getBaseUrl(req: Request) {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = (req.headers.get("x-forwarded-proto") || "http").split(",")[0].trim();
  const host  = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

async function getSnapshot(baseUrl: string): Promise<{ stocks: SnapStock[]; updatedAt: string } | null> {
  try {
    const r = await fetch(`${baseUrl}/api/stocks/snapshot`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return {
      stocks: Array.isArray(j?.stocks) ? j.stocks : [],
      updatedAt: j?.updatedAt || new Date().toISOString()
    };
  } catch {
    return null;
  }
}

/** Ask AI to pick from provided top stocks; if today’s rec exists, return it. */
async function ensureTodayRecommendationFromSnapshot(
  req: Request,
  topStocks: SnapStock[]
) {
  const today = yyyyMmDdET();
  let lastRec = await prisma.recommendation.findFirst({ orderBy: { id: "desc" } });

  const recDay =
    lastRec?.at instanceof Date
      ? `${lastRec.at.getFullYear()}-${String(lastRec.at.getMonth() + 1).padStart(2, "0")}-${String(lastRec.at.getDate()).padStart(2, "0")}`
      : null;

  if (lastRec && recDay === today) return lastRec;
  if (!topStocks.length) return lastRec || null;

  try {
    const base = getBaseUrl(req);
    const rRes = await fetch(`${base}/api/recommendation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Add a couple of nudges so your handler can force a pick
      body: JSON.stringify({ stocks: topStocks, forcePick: true, requirePick: true }),
      cache: "no-store",
    });

    if (!rRes.ok) return lastRec || null;

    const rJson = await rRes.json();
    const txt: string = rJson?.recommendation || "";
    const m = /Pick:\s*([A-Z][A-Z0-9.\-]*)/i.exec(txt);
    const ticker = m?.[1]?.toUpperCase() || null;
    if (!ticker) return lastRec || null;

    const priceCandidate =
      topStocks.find((s: SnapStock) => s.ticker === ticker)?.price ?? (await getQuote(ticker));

    if (priceCandidate == null || !Number.isFinite(Number(priceCandidate))) return lastRec || null;

    lastRec = await prisma.recommendation.create({ data: { ticker, price: Number(priceCandidate) } });
    return lastRec;
  } catch {
    return lastRec || null;
  }
}

/** Same as above, but retries several times within the minute to “make sure it buys”. */
async function ensureTodayRecommendationWithRetries(
  req: Request,
  topStocks: SnapStock[],
  tries = 8,
  delayMs = 750
) {
  for (let i = 0; i < tries; i++) {
    const rec = await ensureTodayRecommendationFromSnapshot(req, topStocks);
    if (rec?.ticker) return rec;
    // tiny backoff to give AI another chance
    await new Promise(res => setTimeout(res, delayMs));
  }
  return null;
}

/** ───────────────── Route handlers ───────────────── */
export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }

async function handle(req: Request) {
  const now = Date.now();

  if (pendingTick) {
    const data = await pendingTick;
    return NextResponse.json(data);
  }
  if (lastTickResponse && now - lastTickAt < MIN_TICK_MS) {
    return NextResponse.json(lastTickResponse);
  }

  pendingTick = (async () => {
    const debug: any = { reasons: [] as string[] };

    // Ensure state exists
    let state = await prisma.botState.findUnique({ where: { id: 1 } });
    if (!state) {
      state = await prisma.botState.create({
        data: { id: 1, cash: START_CASH, pnl: 0, equity: START_CASH }
      });
    }

    // Read open pos & last rec
    let openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
    let lastRec = await prisma.recommendation.findFirst({ orderBy: { id: "desc" } });
    let livePrice: number | null = null;

    const today = yyyyMmDdET();

    /** ── Mandatory exit after 15:55 ET ── */
    if (openPos && isMandatoryExitET()) {
      const exitTicker = openPos.ticker;
      try {
        await closePositionMarket(exitTicker);

        const pQuote = await getQuote(exitTicker);
        const p = (pQuote != null && Number.isFinite(Number(pQuote)))
          ? Number(pQuote)
          : Number(openPos.entryPrice);

        const shares   = Number(openPos.shares);
        const entry    = Number(openPos.entryPrice);
        const exitVal  = shares * p;
        const realized = exitVal - shares * entry;

        await prisma.trade.create({ data: { side: "SELL", ticker: exitTicker, price: p, shares } });
        await prisma.position.update({ where: { id: openPos.id }, data: { open: false, exitPrice: p, exitAt: nowET() } });

        state = await prisma.botState.update({
          where: { id: 1 },
          data: {
            cash:   Number(state.cash) + exitVal,
            pnl:    Number(state.pnl) + realized,
            equity: Number(state.cash) + exitVal,
          },
        });

        openPos = null;
        debug.lastMessage = `⏱️ Mandatory 15:55+ exit ${exitTicker}`;
      } catch (e: any) {
        debug.reasons.push("mandatory_exit_exception");
        console.error("mandatory exit error", e?.message || e);
      }
    }

    // Weekday & market gates
    if (!isWeekdayET()) {
      debug.reasons.push("not_weekday");
      return {
        state, lastRec, position: openPos, live: null,
        serverTimeET: nowET().toISOString(), skipped: "not_weekday", debug
      };
    }
    const marketOpen = isMarketHoursET();

    /** ───────────────── 10:45 ET MANDATORY AI BUY (one/day) ─────────────────
     *  - Requires market open, no open position, daily lock not used
     *  - Aggressively ensures AI returns a pick before buying
     */
    if (!openPos && marketOpen && isMandatoryAiBuyWindow1045ET() && state.lastRunDay !== today) {
      const base = getBaseUrl(req);
      const snapshot = await getSnapshot(base);
      const snapAgeMs = snapshot ? (Date.now() - new Date(snapshot.updatedAt).getTime()) : Number.POSITIVE_INFINITY;
      const hasStocks = !!(snapshot?.stocks?.length);
      const top = (snapshot?.stocks || []).slice(0, TOP_CANDIDATES);

      debug.buy1045_snapshotAgeMs = Number.isFinite(snapAgeMs) ? snapAgeMs : null;
      debug.buy1045_top = top.map(s => s.ticker);

      if (!hasStocks) {
        debug.reasons.push("1045_no_snapshot_stocks");
      } else {
        // REPEATEDLY ASK AI UNTIL IT PICKS (within a few seconds)
        lastRec = await ensureTodayRecommendationWithRetries(req, top, 8, 750);

        if (lastRec?.ticker) {
          // claim 1/day lock
          const claim = await prisma.botState.updateMany({
            where: { id: 1, OR: [{ lastRunDay: null }, { lastRunDay: { not: today } }] },
            data: { lastRunDay: today },
          });
          const claimed = claim.count === 1;
          debug.buy1045_claimed = claimed;

          if (claimed) {
            // re-check open pos after claim
            openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
            if (!openPos) {
              // Choose reference price: snapshot -> rec.price -> quote
              let entryRefPrice: number | null =
                Number(snapshot?.stocks?.find((s: SnapStock) => s.ticker === lastRec!.ticker)?.price ?? NaN);
              if (!Number.isFinite(entryRefPrice)) entryRefPrice = Number(lastRec!.price);
              if (!Number.isFinite(entryRefPrice)) {
                const q = await getQuote(lastRec!.ticker);
                if (q != null && Number.isFinite(Number(q))) entryRefPrice = Number(q);
              }

              if (entryRefPrice != null && Number.isFinite(entryRefPrice)) {
                const mid   = entryRefPrice;
                const limit = mid * (1 + MAX_SLIPPAGE_PCT);
                const tp    = limit * (1 + TARGET_PCT);
                const sl    = limit * (1 + STOP_PCT);

                const cashNum = Number(state.cash);
                const budget  = Math.min(cashNum, INVEST_BUDGET);
                const shares  = Math.floor(budget / limit);

                if (shares > 0) {
                  try {
                    const order = await submitBracketBuy({
                      symbol: lastRec.ticker, qty: shares, limit, tp, sl, tif: "day",
                    });

                    const used = shares * limit;

                    const pos = await prisma.position.create({
                      data: { ticker: lastRec.ticker, entryPrice: limit, shares, open: true, brokerOrderId: order.id },
                    });
                    openPos = pos;

                    await prisma.trade.create({
                      data: { side: "BUY", ticker: lastRec.ticker, price: limit, shares, brokerOrderId: order.id },
                    });

                    await prisma.botState.update({
                      where: { id: 1 },
                      data: { cash: cashNum - used, equity: cashNum - used + shares * limit },
                    });

                    debug.lastMessage = `✅ 10:45 BUY (AI) ${lastRec!.ticker} @ ${limit.toFixed(2)} (shares=${shares})`;
                  } catch (e: any) {
                    debug.reasons.push(`1045_alpaca_submit_error:${e?.message || "unknown"}`);
                    // release lock so you can try next minute by manual trigger, if desired
                    await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
                  }
                } else {
                  debug.reasons.push("1045_insufficient_budget_for_one_share");
                  await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
                }
              } else {
                debug.reasons.push("1045_no_price_for_entry");
                await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
              }
            } else {
              debug.reasons.push("1045_position_open_after_claim");
            }
          } else {
            debug.reasons.push("1045_day_lock_already_claimed");
          }
        } else {
          debug.reasons.push("1045_ai_pick_missing_after_retries");
        }
      }
    }

    /** ───────────────── Holding: refresh equity ───────────────── */
    // (Keeps UI equity fresh while holding)
    if (openPos) {
      let p: number | null = null;
      const base = getBaseUrl(req);
      const snapshot = await getSnapshot(base);
      const s = snapshot?.stocks?.find((x: SnapStock) => x.ticker === openPos!.ticker);
      if (s?.price != null && Number.isFinite(Number(s.price))) {
        p = Number(s.price);
      } else {
        const q = await getQuote(openPos.ticker);
        if (q != null && Number.isFinite(Number(q))) p = Number(q);
      }

      if (p != null) {
        const equityNow = Number(state.cash) + Number(openPos.shares) * p;
        if (Number(state.equity) !== equityNow) {
          state = await prisma.botState.update({ where: { id: 1 }, data: { equity: equityNow } });
        }
      }
    }

    // Live price for UI (lastRec or openPos)
    const liveTicker: string | null = openPos?.ticker ?? (lastRec as any)?.ticker ?? null;
    if (liveTicker && livePrice == null) {
      const q = await getQuote(liveTicker);
      if (q != null && Number.isFinite(Number(q))) livePrice = Number(q);
    }

    return {
      state,
      lastRec,
      position: openPos,
      live: { ticker: liveTicker, price: livePrice },
      serverTimeET: nowET().toISOString(),
      info: {
        mandatoryAiBuyWindow_1045: isMandatoryAiBuyWindow1045ET(),
        isMandatoryExit_1555: isMandatoryExitET(),
        investBudget: INVEST_BUDGET,
        targetPct: TARGET_PCT,
        stopPct: STOP_PCT,
      },
      debug,
    };
  })();

  try {
    const data = await pendingTick;
    lastTickAt = Date.now();
    lastTickResponse = data;
    return NextResponse.json(data);
  } finally {
    pendingTick = null;
  }
}
