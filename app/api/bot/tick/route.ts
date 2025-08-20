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
// tick fast; we also run an internal burst within the handler
const MIN_TICK_MS = 200;

/** ───────────────── Config ───────────────── */
const START_CASH = 4000;
const INVEST_BUDGET = 4000;          // cap per trade; if cash < 4k, use all cash
const TARGET_PCT = 0.10;             // +10% take-profit
const STOP_PCT   = -0.05;            // -5% stop-loss
const SLIPPAGE_STEPS = [0.003, 0.006, 0.010]; // kept for info/debug display
const TOP_CANDIDATES = 8;

// Must the AI pick? (set to false if you want a hard fallback to top[0])
const REQUIRE_AI_PICK = true;

/** ───────────────── 12:30 ET plan ─────────────────
 * Prewarm:      12:29:30–12:29:59
 * Buy window:   12:30:00–12:31:59 (2 minutes)
 * Internal burst: 12 tries ~ every 300ms inside a single invocation
 */
function inPrewarmWindow() {
  const d = nowET();
  return d.getHours() === 12 && d.getMinutes() === 29 && d.getSeconds() >= 30;
}
function inBuyWindow() {
  const d = nowET();
  return d.getHours() === 12 && (d.getMinutes() === 30 || d.getMinutes() === 31);
}
// Failsafe to clear a stuck lock near end of window
function inEndOfWindowFailsafe() {
  const d = nowET();
  return d.getHours() === 12 && d.getMinutes() === 31 && d.getSeconds() >= 30;
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

function getBaseUrl(req: Request) {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = (req.headers.get("x-forwarded-proto") || "http").split(",")[0].trim();
  const host  = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

// Last-good (same-day) snapshot cache to survive empty/late snapshots
let lastGoodSnapshot: { stocks: SnapStock[]; updatedAt: string } | null = null;
let lastGoodSnapshotDay: string | null = null;

async function getSnapshot(baseUrl: string): Promise<{ stocks: SnapStock[]; updatedAt: string } | null> {
  try {
    const r = await fetch(`${baseUrl}/api/stocks/snapshot`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    const snap = {
      stocks: Array.isArray(j?.stocks) ? j.stocks : [],
      updatedAt: j?.updatedAt || new Date().toISOString(),
    };
    // update last-good cache if non-empty and same day
    if (snap.stocks.length) {
      const today = yyyyMmDdET();
      const snapDay = yyyyMmDdLocal(new Date(snap.updatedAt));
      if (snapDay === today) {
        lastGoodSnapshot = snap;
        lastGoodSnapshotDay = today;
      }
    }
    return snap;
  } catch {
    return null;
  }
}

function yyyyMmDdLocal(d: Date) {
  const dt = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mo = String(dt.getMonth() + 1).padStart(2, "0");
  const da = String(dt.getDate()).padStart(2, "0");
  return `${dt.getFullYear()}-${mo}-${da}`;
}

// ✅ fixed: getMonth() not getMonth
function yyyyMmDd(date: Date) {
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const da = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mo}-${da}`;
}

/** Parse AI recommendation in multiple formats */
function parseAIPick(rJson: any): string | null {
  // JSON fields first
  const direct =
    rJson?.ticker ||
    rJson?.symbol ||
    rJson?.pick ||
    rJson?.Pick ||
    rJson?.data?.ticker ||
    rJson?.data?.symbol;
  if (typeof direct === "string" && /^[A-Za-z][A-Za-z0-9.\-]*$/.test(direct)) {
    return direct.toUpperCase();
  }
  // Then free-text "Pick: TICKER"
  const txt: string = (rJson?.recommendation ?? rJson?.text ?? rJson?.message ?? "") + "";
  const m = /Pick:\s*([A-Z][A-Z0-9.\-]*)/i.exec(txt);
  return m?.[1]?.toUpperCase() || null;
}

/** Ask AI for today's pick from top stocks; if already have today's pick, return it. */
async function ensureTodayRecommendationFromSnapshot(req: Request, topStocks: SnapStock[]) {
  const today = yyyyMmDd(nowET());
  let lastRec = await prisma.recommendation.findFirst({ orderBy: { id: "desc" } });

  const recDay =
    lastRec?.at instanceof Date ? yyyyMmDd(lastRec.at) : null;

  if (lastRec && recDay === today) return lastRec;

  try {
    const base = getBaseUrl(req);
    const rRes = await fetch(`${base}/api/recommendation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stocks: topStocks, forcePick: true, requirePick: true }),
      cache: "no-store",
    });

    if (!rRes.ok) return lastRec || null;

    const rJson = await rRes.json();
    const ticker = parseAIPick(rJson);
    if (!ticker) return lastRec || null;

    // prefer snapshot price; fallback to live quote
    const snapPrice = topStocks.find((s) => s.ticker === ticker)?.price;
    const priceCandidate = snapPrice ?? (await getQuote(ticker));
    if (priceCandidate == null || !Number.isFinite(Number(priceCandidate))) return lastRec || null;

    lastRec = await prisma.recommendation.create({ data: { ticker, price: Number(priceCandidate) } });
    return lastRec;
  } catch {
    return lastRec || null;
  }
}

/** Aggressively ask AI up to N times with short delays. */
async function ensureTodayRecommendationWithRetries(
  req: Request,
  topStocks: SnapStock[],
  tries = 12,
  delayMs = 300
) {
  for (let i = 0; i < tries; i++) {
    const rec = await ensureTodayRecommendationFromSnapshot(req, topStocks);
    if (rec?.ticker) return rec;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return null;
}

/** (Kept for reference) Widening-limit helper — not used when market entry is enabled */
async function submitBuyWithWideningSlippage(
  symbol: string,
  cashAvailable: number,
  baseRefPrice: number
) {
  let lastErr: any = null;
  for (const slip of SLIPPAGE_STEPS) {
    const q = await getQuote(symbol); // refresh quote each attempt
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
        entryType: "limit",
        limit,
        tp,
        sl,
        tif: "day",
      });
      return { ok: true as const, order, priceUsed: limit, shares };
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

    // Ensure state exists
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
      }
    }

    // Weekday & market gates
    if (!isWeekdayET()) {
      debug.reasons.push("not_weekday");
      return {
        state, lastRec, position: openPos, live: null,
        serverTimeET: nowET().toISOString(), skipped: "not_weekday", debug,
      };
    }
    const marketOpen = isMarketHoursET();

    /** ───────────────── 12:29:30–12:29:59 Pre-warm ───────────────── */
    if (!openPos && marketOpen && inPrewarmWindow()) {
      const base = getBaseUrl(req);
      const snapshot = await getSnapshot(base); // freshness bypass ok
      const top = (snapshot?.stocks || []).slice(0, TOP_CANDIDATES);

      // prefer affordable candidates to avoid shares=0
      const affordableTop = top.filter(s => Number.isFinite(Number(s.price)) && Number(s.price) <= INVEST_BUDGET);
      const candidates = affordableTop.length ? affordableTop : top;
      debug.prewarm_top = candidates.map((s) => s.ticker);
      debug.prewarm_affordable_count = affordableTop.length;

      try {
        const rec = await ensureTodayRecommendationFromSnapshot(req, candidates);
        if (rec?.ticker) {
          debug.prewarm_pick = rec.ticker;
        } else {
          debug.reasons.push("prewarm_no_pick_yet");
        }
      } catch (e: any) {
        debug.reasons.push(`prewarm_exception:${e?.message || "unknown"}`);
      }
    }

    /** ───────────────── 12:30:00–12:31:59 Buy Window ───────────────── */
    if (!openPos && marketOpen && inBuyWindow() && state.lastRunDay !== today) {
      const base = getBaseUrl(req);
      let snapshot = await getSnapshot(base); // bypass freshness in window
      let top = (snapshot?.stocks || []).slice(0, TOP_CANDIDATES);

      // Fallback to last-good if empty
      if (!top.length && lastGoodSnapshot && lastGoodSnapshotDay === today) {
        top = lastGoodSnapshot.stocks.slice(0, TOP_CANDIDATES);
        debug.used_last_good_snapshot = true;
      }

      // prefer affordable candidates to avoid shares=0
      const affordableTop = top.filter(s => Number.isFinite(Number(s.price)) && Number(s.price) <= INVEST_BUDGET);
      const candidates = affordableTop.length ? affordableTop : top;

      debug.buy1230_top = candidates.map((s) => s.ticker);
      debug.buy1230_affordable_count = affordableTop.length;

      // Internal burst loop: several tries in one invocation
      const BURST_TRIES = 12;
      const BURST_DELAY_MS = 300;

      for (let i = 0; i < BURST_TRIES; i++) {
        // 1) Make sure we have an AI pick (or fallback if allowed)
        let rec = await ensureTodayRecommendationFromSnapshot(req, candidates);
        if (!rec?.ticker && !REQUIRE_AI_PICK && candidates.length) {
          // HARD FALLBACK if allowed
          const fb = candidates[0];
          const fallbackTicker = fb.ticker;
          const fallbackPrice = fb.price ?? (await getQuote(fallbackTicker));
          if (fallbackTicker && fallbackPrice && Number.isFinite(Number(fallbackPrice))) {
            rec = await prisma.recommendation.create({
              data: { ticker: fallbackTicker, price: Number(fallbackPrice) },
            });
            debug.fallback_used = true;
          }
        }

        if (!rec?.ticker) {
          debug.reasons.push(`1230_no_pick_iter_${i}`);
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }

        lastRec = rec;

        // 2) Claim daily lock
        const claim = await prisma.botState.updateMany({
          where: { id: 1, OR: [{ lastRunDay: null }, { lastRunDay: { not: today } }] },
          data: { lastRunDay: today },
        });
        const claimed = claim.count === 1;
        debug[`iter_${i}_claimed`] = claimed;

        if (!claimed) {
          debug.reasons.push(`1230_day_lock_already_claimed_iter_${i}`);
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }

        // 3) After claiming, re-check no open pos
        openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
        if (openPos) {
          debug.reasons.push(`1230_position_open_after_claim_iter_${i}`);
          break; // someone else bought
        }

        // 4) Build entry ref price: snapshot -> rec.price -> quote
        let ref: number | null =
          Number(snapshot?.stocks?.find((s) => s.ticker === rec!.ticker)?.price ?? NaN);
        if (!Number.isFinite(Number(ref))) ref = Number(rec!.price);
        if (!Number.isFinite(Number(ref))) {
          const q = await getQuote(rec!.ticker);
          if (q != null && Number.isFinite(Number(q))) ref = Number(q);
        }

        if (ref == null || !Number.isFinite(Number(ref))) {
          debug.reasons.push(`1230_no_price_for_entry_iter_${i}`);
          // release lock and retry
          await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }

        // 5) Submit as a MARKET bracket (fills immediately)
        const cashNum = Number(state.cash);
        const shares = Math.floor(Math.min(cashNum, INVEST_BUDGET) / ref);

        if (shares <= 0) {
          debug.reasons.push(`1230_insufficient_cash_for_one_share_ref_${ref.toFixed(2)}`);
          // release lock so next iteration can try again (or another pick)
          await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }

        const tp = ref * (1 + TARGET_PCT);
        const sl = ref * (1 + STOP_PCT);

        try {
          const order = await submitBracketBuy({
            symbol: rec!.ticker,
            qty: shares,
            entryType: "market",   // key change
            tp,
            sl,
            tif: "day",
          });

          const pos = await prisma.position.create({
            data: { ticker: rec!.ticker, entryPrice: ref, shares, open: true, brokerOrderId: order.id },
          });
          openPos = pos;

          await prisma.trade.create({
            data: { side: "BUY", ticker: rec!.ticker, price: ref, shares, brokerOrderId: order.id },
          });

          await prisma.botState.update({
            where: { id: 1 },
            data: { cash: cashNum - shares * ref, equity: cashNum - shares * ref + shares * ref },
          });

          debug.lastMessage = `✅ 12:30 BUY (market bracket) ${rec!.ticker} @ ~${ref.toFixed(2)} (shares=${shares})`;
          break; // success
        } catch (e: any) {
          const msg = e?.message || "unknown";
          const body = e?.body ? JSON.stringify(e.body).slice(0, 300) : "";
          debug.reasons.push(`1230_alpaca_submit_failed_iter_${i}:${msg}${body ? " body="+body : ""}`);
          // release lock so we can retry within the window
          await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }
      }
    }

    /** ── End-of-window lock failsafe (clear stuck lock so next tick can retry) ── */
    if (!openPos && inEndOfWindowFailsafe()) {
      if (state.lastRunDay === yyyyMmDdET()) {
        await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
        (debug.reasons as string[]).push("1230_failsafe_cleared_day_lock");
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
        prewarm_122930_122959: inPrewarmWindow(),
        buyWindow_123000_123159: inBuyWindow(),
        requireAiPick: REQUIRE_AI_PICK,
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
