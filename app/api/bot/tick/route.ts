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
// Tick fast during the 11:05 window
const MIN_TICK_MS = 300;

/** ───────────────── Config ───────────────── */
const START_CASH = 4000;
const INVEST_BUDGET = 4000;        // cap per trade; if cash < 4k use all cash
const TARGET_PCT = 0.10;           // +10% TP
const STOP_PCT   = -0.05;          // -5% SL
const BASE_SLIPPAGE = 0.003;       // 0.30%
const MAX_SLIPPAGE  = 0.010;       // 1.00% hard ceiling
const SLIPPAGE_STEPS = [0.003, 0.006, 0.010]; // widen if broker rejects
const TOP_CANDIDATES = 8;

/** ───────────────── 11:05 ET AI Buy Plan ─────────────────
 *  - Prewarm: 11:04:30–11:04:59 (ask AI early)
 *  - Mandatory AI-buy window: 11:05:00–11:06:59 (2 minutes for robust retries)
 */
function inAiPrewarmWindow1105() {
  const d = nowET();
  return d.getHours() === 11 && d.getMinutes() === 4 && d.getSeconds() >= 30;
}
function inAiMandatoryBuyWindow1105() {
  const d = nowET();
  return d.getHours() === 11 && (d.getMinutes() === 5 || d.getMinutes() === 6);
}

/** ───────────────── Exit Rule ───────────────── */
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
      updatedAt: j?.updatedAt || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** Ask AI for today's pick from top stocks; if already have today's pick, return it. */
async function ensureTodayRecommendationFromSnapshot(req: Request, topStocks: SnapStock[]) {
  const today = yyyyMmDdET();
  let lastRec = await prisma.recommendation.findFirst({ orderBy: { id: "desc" } });

  const recDay =
    lastRec?.at instanceof Date
      ? `${lastRec.at.getFullYear()}-${String(lastRec.at.getMonth() + 1).padStart(2, "0")}-${String(lastRec.at.getDate()).padStart(2, "0")}`
      : null;

  if (lastRec && recDay === today) return lastRec;

  try {
    const base = getBaseUrl(req);
    const rRes = await fetch(`${base}/api/recommendation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Nudge your handler to always pick one
      body: JSON.stringify({ stocks: topStocks, forcePick: true, requirePick: true }),
      cache: "no-store",
    });

    if (!rRes.ok) return lastRec || null;

    const rJson = await rRes.json();
    const txt: string = rJson?.recommendation || "";
    const m = /Pick:\s*([A-Z][A-Z0-9.\-]*)/i.exec(txt);
    const ticker = m?.[1]?.toUpperCase() || null;
    if (!ticker) return lastRec || null;

    // Prefer snapshot price to avoid extra API call; fallback to live quote
    const snapPrice = topStocks.find((s) => s.ticker === ticker)?.price;
    const priceCandidate = snapPrice ?? (await getQuote(ticker));
    if (priceCandidate == null || !Number.isFinite(Number(priceCandidate))) return lastRec || null;

    lastRec = await prisma.recommendation.create({ data: { ticker, price: Number(priceCandidate) } });
    return lastRec;
  } catch {
    return lastRec || null;
  }
}

/** Repeatedly ask AI until it returns a pick. */
async function ensureTodayRecommendationWithRetries(
  req: Request,
  topStocks: SnapStock[],
  tries = 10,
  delayMs = 500
) {
  for (let i = 0; i < tries; i++) {
    const rec = await ensureTodayRecommendationFromSnapshot(req, topStocks);
    if (rec?.ticker) return rec;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return null;
}

/** Submit bracket buy with widening slippage and refreshed quotes. */
async function submitBuyWithWideningSlippage(
  symbol: string,
  cashAvailable: number,
  baseRefPrice: number
) {
  let lastErr: any = null;
  for (const slip of SLIPPAGE_STEPS) {
    // refresh quote each attempt to avoid stale price rejects
    const q = await getQuote(symbol);
    const ref = Number.isFinite(Number(q)) ? Number(q) : baseRefPrice;

    const limit = ref * (1 + slip);
    const tp    = limit * (1 + TARGET_PCT);
    const sl    = limit * (1 + STOP_PCT);

    const budget = Math.min(cashAvailable, INVEST_BUDGET);
    const shares = Math.floor(budget / limit);
    if (shares <= 0) {
      lastErr = new Error("insufficient_cash_for_one_share");
      continue;
    }

    try {
      const order = await submitBracketBuy({
        symbol,
        qty: shares,
        limit,
        tp,
        sl,
        tif: "day",
      });
      return { ok: true as const, order, limit, shares };
    } catch (e: any) {
      lastErr = e;
    }
  }
  return { ok: false as const, error: lastErr };
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

    // Ensure state row exists
    let state = await prisma.botState.findUnique({ where: { id: 1 } });
    if (!state) {
      state = await prisma.botState.create({
        data: { id: 1, cash: START_CASH, pnl: 0, equity: START_CASH },
      });
    }

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

    // Weekday & market open gates
    if (!isWeekdayET()) {
      debug.reasons.push("not_weekday");
      return {
        state, lastRec, position: openPos, live: null,
        serverTimeET: nowET().toISOString(), skipped: "not_weekday", debug,
      };
    }
    const marketOpen = isMarketHoursET();

    /** ───────────────── 11:04:30–11:04:59 Pre-warm ─────────────────
     *  Ask the AI early so the pick exists at 11:05.
     */
    if (!openPos && marketOpen && inAiPrewarmWindow1105()) {
      const base = getBaseUrl(req);
      const snapshot = await getSnapshot(base); // no freshness requirement in prewarm
      const top = (snapshot?.stocks || []).slice(0, TOP_CANDIDATES);
      debug.prewarm_top = top.map((s) => s.ticker);
      try {
        const rec = await ensureTodayRecommendationFromSnapshot(req, top);
        if (rec?.ticker) {
          debug.prewarm_pick = rec.ticker;
        } else {
          debug.reasons.push("prewarm_no_pick_yet");
        }
      } catch (e: any) {
        debug.reasons.push(`prewarm_exception:${e?.message || "unknown"}`);
      }
    }

    /** ───────────────── 11:05:00–11:06:59 Mandatory AI Buy ─────────────────
     *  Only if: marketOpen, no open position, and day lock unused.
     *  Steps:
     *   1) Get snapshot (no freshness requirement here).
     *   2) Aggressively ensure AI pick (up to ~10 tries).
     *   3) Claim daily lock.
     *   4) Submit bracket buy with widening slippage and refreshed quotes.
     *   5) If any stage fails, release the lock so we can retry again in-window.
     */
    if (!openPos && marketOpen && inAiMandatoryBuyWindow1105() && state.lastRunDay !== today) {
      const base = getBaseUrl(req);
      const snapshot = await getSnapshot(base); // bypass freshness in this window
      const top = (snapshot?.stocks || []).slice(0, TOP_CANDIDATES);
      debug.buy1105_top = top.map((s) => s.ticker);

      // 1 & 2: Ensure AI pick with retries
      lastRec = await ensureTodayRecommendationWithRetries(req, top, 10, 500);
      if (!lastRec?.ticker) {
        debug.reasons.push("1105_ai_pick_missing_after_retries");
      } else {
        // 3: Try to claim daily lock
        const claim = await prisma.botState.updateMany({
          where: { id: 1, OR: [{ lastRunDay: null }, { lastRunDay: { not: today } }] },
          data: { lastRunDay: today },
        });
        const claimed = claim.count === 1;
        debug.buy1105_claimed = claimed;

        if (claimed) {
          // Re-check no position after claim
          openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
          if (!openPos) {
            // Price ref: snapshot -> rec.price -> live quote
            let ref: number | null =
              Number(snapshot?.stocks?.find((s) => s.ticker === lastRec!.ticker)?.price ?? NaN);
            if (!Number.isFinite(ref)) ref = Number(lastRec!.price);
            if (!Number.isFinite(ref)) {
              const q = await getQuote(lastRec!.ticker);
              if (q != null && Number.isFinite(Number(q))) ref = Number(q);
            }

            if (ref != null && Number.isFinite(Number(ref))) {
              // 4: Submit with widening slippage
              const cashNum = Number(state.cash);
              const result = await submitBuyWithWideningSlippage(lastRec!.ticker, cashNum, ref);

              if (result.ok) {
                const { order, limit, shares } = result;

                const pos = await prisma.position.create({
                  data: { ticker: lastRec!.ticker, entryPrice: limit, shares, open: true, brokerOrderId: order.id },
                });
                openPos = pos;

                await prisma.trade.create({
                  data: { side: "BUY", ticker: lastRec!.ticker, price: limit, shares, brokerOrderId: order.id },
                });

                await prisma.botState.update({
                  where: { id: 1 },
                  data: { cash: cashNum - shares * limit, equity: cashNum - shares * limit + shares * limit },
                });

                debug.lastMessage = `✅ 11:05 BUY (AI) ${lastRec!.ticker} @ ${limit.toFixed(2)} (shares=${shares})`;
              } else {
                // 5: Release lock so we can retry within the window
                await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
                debug.reasons.push(`1105_alpaca_submit_failed:${result.error?.message || "unknown"}`);
              }
            } else {
              await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
              debug.reasons.push("1105_no_price_for_entry");
            }
          } else {
            debug.reasons.push("1105_position_open_after_claim");
          }
        } else {
          debug.reasons.push("1105_day_lock_already_claimed");
        }
      }
    }

    /** ───────────────── Holding: refresh equity for UI ───────────────── */
    if (openPos) {
      const q = await getQuote(openPos.ticker);
      if (q != null && Number.isFinite(Number(q))) {
        const p = Number(q);
        const equityNow = Number(state.cash) + Number(openPos.shares) * p;
        if (Number(state.equity) !== equityNow) {
          state = await prisma.botState.update({ where: { id: 1 }, data: { equity: equityNow } });
        }
        livePrice = p;
      }
    } else if (lastRec?.ticker) {
      // show live price of the candidate when not in a position
      const q = await getQuote(lastRec.ticker);
      if (q != null && Number.isFinite(Number(q))) livePrice = Number(q);
    }

    return {
      state,
      lastRec,
      position: openPos,
      live: { ticker: openPos?.ticker ?? lastRec?.ticker ?? null, price: livePrice },
      serverTimeET: nowET().toISOString(),
      info: {
        prewarm_110430_110459: inAiPrewarmWindow1105(),
        mandatoryAiBuyWindow_110500_110659: inAiMandatoryBuyWindow1105(),
        isMandatoryExit_1555: isMandatoryExitET(),
        targetPct: TARGET_PCT,
        stopPct: STOP_PCT,
        slippageSteps: SLIPPAGE_STEPS,
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
