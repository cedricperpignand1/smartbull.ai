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
const MIN_TICK_MS = 200;

/** ───────────────── Config ───────────────── */
const START_CASH = 4000;
const INVEST_BUDGET = 4000;          // cap per trade; if cash < 4k, use all cash
const TARGET_PCT = 0.10;             // +10% take-profit
const STOP_PCT   = -0.05;            // -5% stop-loss
const TOP_CANDIDATES = 8;

// Must the AI pick? (true = no fallback)
const REQUIRE_AI_PICK = true;

/** ───────────────── Time Windows (ET) ─────────────────
 * Scan   : 09:34:00–10:14:59 (require setups)
 * Force  : 10:15:00–10:16:59 (buy AI pick, ignore setups)
 * Prewarm: 09:33:30–09:33:59 and 10:14:30–10:14:59
 * Exit   : 15:55+
 */
function inScanWindow() {
  const d = nowET();
  const m = d.getHours() * 60 + d.getMinutes();
  const s = d.getSeconds();
  // 9:34:00 (574) to 10:14:59 (614 with seconds<60)
  return m >= 9 * 60 + 34 && m <= 10 * 60 + 14 && s <= 59;
}
function inForceWindow() {
  const d = nowET();
  return d.getHours() === 10 && (d.getMinutes() === 15 || d.getMinutes() === 16);
}
function inPrewarmWindow() {
  const d = nowET();
  const h = d.getHours(), mi = d.getMinutes(), s = d.getSeconds();
  return (h === 9 && mi === 33 && s >= 30) || (h === 10 && mi === 14 && s >= 30);
}
function inEndOfForceFailsafe() {
  const d = nowET();
  return d.getHours() === 10 && d.getMinutes() === 16 && d.getSeconds() >= 30;
}
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
type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };

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
function yyyyMmDd(date: Date) {
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const da = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mo}-${da}`;
}

/** Robust AI recommendation parser */
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
  // 2) Context array: { context: { tickers: [ { ticker: "XYZ" } ] } }
  const ctxTicker = rJson?.context?.tickers?.[0]?.ticker;
  if (typeof ctxTicker === "string" && /^[A-Za-z][A-Za-z0-9.\-]*$/.test(ctxTicker)) {
    return ctxTicker.toUpperCase();
  }
  // 3) Free text / markdown: "**Pick:** XYZ" or "Pick: XYZ" / "Pick - XYZ"
  let txt = String(rJson?.recommendation ?? rJson?.text ?? rJson?.message ?? "");
  txt = txt.replace(/[*_`~]/g, "").replace(/^-+\s*/gm, "");
  const m1 = /Pick\s*:?\s*([A-Z][A-Z0-9.\-]*)/i.exec(txt);
  const m2 = /Pick\s*[-–—]\s*([A-Z][A-Z0-9.\-]*)/i.exec(txt);
  const sym = (m1?.[1] || m2?.[1])?.toUpperCase();
  return sym || null;
}

/** ───────────────── Intraday 1-min data helpers ───────────────── */
function toET(dateIso: string) {
  return new Date(new Date(dateIso).toLocaleString("en-US", { timeZone: "America/New_York" }));
}
function isSameETDay(d: Date, ymd: string) {
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}` === ymd;
}
async function fetchCandles1m(symbol: string, limit = 240): Promise<Candle[]> {
  const rel = `/api/fmp/candles?symbol=${encodeURIComponent(symbol)}&interval=1min&limit=${limit}`;
  const res = await fetch(rel, { cache: "no-store" });
  if (!res.ok) return [];
  const j = await res.json();
  const arr = Array.isArray(j?.candles) ? j.candles : [];
  return arr.map((c: any) => ({
    date: c.date,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
  }));
}

/** ───────────────── Intraday signals ───────────────── */
function computeOpeningRange(candles: Candle[], todayYMD: string) {
  const window = candles.filter((c) => {
    const d = toET(c.date);
    return isSameETDay(d, todayYMD) && d.getHours() === 9 && d.getMinutes() >= 30 && d.getMinutes() <= 34;
  });
  if (!window.length) return null;
  const high = Math.max(...window.map((c) => c.high));
  const low  = Math.min(...window.map((c) => c.low));
  return { high, low, count: window.length };
}
function computeSessionVWAP(candles: Candle[], todayYMD: string) {
  const session = candles.filter((c) => {
    const d = toET(c.date);
    const mins = d.getHours() * 60 + d.getMinutes();
    return isSameETDay(d, todayYMD) && mins >= 9 * 60 + 30;
  });
  if (!session.length) return null;
  let pvSum = 0, volSum = 0;
  for (const c of session) {
    const typical = (c.high + c.low + c.close) / 3;
    pvSum += typical * c.volume;
    volSum += c.volume;
  }
  return volSum > 0 ? pvSum / volSum : null;
}
function computeVolumePulse(candles: Candle[], todayYMD: string, lookback = 5) {
  const dayC = candles.filter((c) => isSameETDay(toET(c.date), todayYMD));
  if (dayC.length < lookback + 1) return null;
  const latest = dayC[dayC.length - 1];
  const prior  = dayC.slice(-1 - lookback, -1);
  const avgPrior = prior.reduce((s, c) => s + c.volume, 0) / lookback;
  if (!avgPrior) return { mult: null as number | null, latestVol: latest.volume, avgPrior };
  return { mult: latest.volume / avgPrior, latestVol: latest.volume, avgPrior };
}
function computeDayHighSoFar(candles: Candle[], todayYMD: string) {
  const day = candles.filter((c) => isSameETDay(toET(c.date), todayYMD));
  if (day.length < 2) return null;
  const prior = day.slice(0, -1);
  return Math.max(...prior.map((c) => c.high));
}
function brokeRecentHighs(candles: Candle[], todayYMD: string, n = 3) {
  const day = candles.filter((c) => isSameETDay(toET(c.date), todayYMD));
  if (day.length < n + 1) return false;
  const last  = day[day.length - 1];
  const prior = day.slice(-1 - n, -1);
  const priorMax = Math.max(...prior.map((c) => c.high));
  return last.close > priorMax;
}

/** Ask AI for today's pick from top stocks; if already have today's pick, return it. */
async function ensureTodayRecommendationFromSnapshot(req: Request, topStocks: SnapStock[]) {
  const today = yyyyMmDd(nowET());
  let lastRec = await prisma.recommendation.findFirst({ orderBy: { id: "desc" } });

  const recDay = lastRec?.at instanceof Date ? yyyyMmDd(lastRec.at) : null;
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

    /** ───────────────── Pre-warm AI pick ───────────────── */
    if (!openPos && marketOpen && inPrewarmWindow()) {
      const base = getBaseUrl(req);
      const snapshot = await getSnapshot(base);
      const top = (snapshot?.stocks || []).slice(0, TOP_CANDIDATES);

      const affordableTop = top.filter(s => Number.isFinite(Number(s.price)) && Number(s.price) <= INVEST_BUDGET);
      const candidates = affordableTop.length ? affordableTop : top;

      debug.prewarm_top = candidates.map((s) => s.ticker);
      debug.prewarm_affordable_count = affordableTop.length;

      try {
        const rec = await ensureTodayRecommendationFromSnapshot(req, candidates);
        if (rec?.ticker) debug.prewarm_pick = rec.ticker;
        else debug.reasons.push("prewarm_no_pick_yet");
      } catch (e: any) {
        debug.reasons.push(`prewarm_exception:${e?.message || "unknown"}`);
      }
    }

    /** ───────────────── 09:34–10:14 Scan Window (signals required) ───────────────── */
    if (!openPos && marketOpen && inScanWindow() && state.lastRunDay !== today) {
      const base = getBaseUrl(req);
      let snapshot = await getSnapshot(base);
      let top = (snapshot?.stocks || []).slice(0, TOP_CANDIDATES);

      if (!top.length && lastGoodSnapshot && lastGoodSnapshotDay === today) {
        top = lastGoodSnapshot.stocks.slice(0, TOP_CANDIDATES);
        debug.used_last_good_snapshot_scan = true;
      }

      const affordableTop = top.filter(s => Number.isFinite(Number(s.price)) && Number(s.price) <= INVEST_BUDGET);
      const candidates = affordableTop.length ? affordableTop : top;

      debug.scan_top = candidates.map((s) => s.ticker);
      debug.scan_affordable_count = affordableTop.length;

      const rec = await ensureTodayRecommendationFromSnapshot(req, candidates);
      if (!rec?.ticker) {
        debug.reasons.push("scan_no_ai_pick_yet");
      } else {
        lastRec = rec;
        // compute setups
        try {
          const candles = await fetchCandles1m(rec!.ticker, 240);
          const day = candles.filter((c) => isSameETDay(toET(c.date), today));
          if (!day.length) {
            debug.reasons.push("scan_no_day_candles");
          } else {
            const orRange = computeOpeningRange(candles, today);
            const vwap    = computeSessionVWAP(candles, today);
            const vol     = computeVolumePulse(candles, today, 5);
            const last    = day[day.length - 1];
            const dayHigh = computeDayHighSoFar(candles, today);

            const aboveVWAP = vwap != null && last ? last.close >= vwap : false;
            const brokeOR   = !!(orRange && last && last.close > orRange.high);
            const pullback  = !!(orRange && last && last.low   >= orRange.high * 0.985);
            const brokeDay  = (typeof dayHigh === "number" && last) ? last.close > dayHigh : brokeOR;
            const broke3    = brokeRecentHighs(candles, today, 3);
            const volOK     = (vol?.mult ?? 0) >= 1.1;

            const armed = aboveVWAP && volOK && ((brokeOR && pullback) || brokeDay || broke3);
            debug.scan_signals = { aboveVWAP, brokeOR, pullback, brokeDay, broke3, volMult: vol?.mult ?? null };

            if (armed) {
              // claim lock
              const claim = await prisma.botState.updateMany({
                where: { id: 1, OR: [{ lastRunDay: null }, { lastRunDay: { not: today } }] },
                data: { lastRunDay: today },
              });
              const claimed = claim.count === 1;
              if (!claimed) {
                debug.reasons.push("scan_day_lock_already_claimed");
              } else {
                // re-check and place order
                openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
                if (openPos) {
                  debug.reasons.push("scan_pos_open_after_claim");
                } else {
                  // reference price for sizing / TP/SL
                  let ref: number | null =
                    Number(snapshot?.stocks?.find((s) => s.ticker === rec!.ticker)?.price ?? NaN);
                  if (!Number.isFinite(Number(ref))) ref = Number(rec!.price);
                  if (!Number.isFinite(Number(ref))) {
                    const q = await getQuote(rec!.ticker);
                    if (q != null && Number.isFinite(Number(q))) ref = Number(q);
                  }

                  if (ref == null || !Number.isFinite(Number(ref))) {
                    debug.reasons.push("scan_no_price_for_entry");
                    await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
                  } else {
                    const cashNum = Number(state.cash);
                    const shares = Math.floor(Math.min(cashNum, INVEST_BUDGET) / ref);
                    if (shares <= 0) {
                      debug.reasons.push(`scan_insufficient_cash_for_one_share_ref_${ref.toFixed(2)}`);
                      await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
                    } else {
                      const tp = ref * (1 + TARGET_PCT);
                      const sl = ref * (1 + STOP_PCT);

                      try {
                        const order = await submitBracketBuy({
                          symbol: rec!.ticker,
                          qty: shares,
                          entryType: "market",
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

                        debug.lastMessage = `✅ 09:34–10:14 BUY (signals armed) ${rec!.ticker} @ ~${ref.toFixed(2)} (shares=${shares})`;
                      } catch (e: any) {
                        const msg = e?.message || "unknown";
                        const body = e?.body ? JSON.stringify(e.body).slice(0, 300) : "";
                        debug.reasons.push(`scan_alpaca_submit_failed:${msg}${body ? " body="+body : ""}`);
                        await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
                      }
                    }
                  }
                }
              }
            } else {
              debug.reasons.push("scan_signals_not_armed");
            }
          }
        } catch (e: any) {
          debug.reasons.push(`scan_signal_exception:${e?.message || "unknown"}`);
        }
      }
    }

    /** ───────────────── 10:15–10:16 Force Window (signals ignored) ───────────────── */
    if (!openPos && marketOpen && inForceWindow() && state.lastRunDay !== today) {
      const base = getBaseUrl(req);
      let snapshot = await getSnapshot(base);
      let top = (snapshot?.stocks || []).slice(0, TOP_CANDIDATES);

      if (!top.length && lastGoodSnapshot && lastGoodSnapshotDay === today) {
        top = lastGoodSnapshot.stocks.slice(0, TOP_CANDIDATES);
        debug.used_last_good_snapshot_force = true;
      }

      const affordableTop = top.filter(s => Number.isFinite(Number(s.price)) && Number(s.price) <= INVEST_BUDGET);
      const candidates = affordableTop.length ? affordableTop : top;

      debug.force_top = candidates.map((s) => s.ticker);
      debug.force_affordable_count = affordableTop.length;

      // small burst inside force window to ensure we place something
      const BURST_TRIES = 12;
      const BURST_DELAY_MS = 300;

      for (let i = 0; i < BURST_TRIES && !openPos; i++) {
        const rec = await ensureTodayRecommendationFromSnapshot(req, candidates);
        if (!rec?.ticker) {
          debug.reasons.push(`force_no_ai_pick_iter_${i}`);
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }

        lastRec = rec;

        // claim lock
        const claim = await prisma.botState.updateMany({
          where: { id: 1, OR: [{ lastRunDay: null }, { lastRunDay: { not: today } }] },
          data: { lastRunDay: today },
        });
        const claimed = claim.count === 1;
        debug[`force_iter_${i}_claimed`] = claimed;

        if (!claimed) {
          debug.reasons.push(`force_day_lock_already_claimed_iter_${i}`);
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }

        // ensure no pos after claim
        openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
        if (openPos) {
          debug.reasons.push(`force_pos_open_after_claim_iter_${i}`);
          break;
        }

        // ref price
        let ref: number | null =
          Number(snapshot?.stocks?.find((s) => s.ticker === rec!.ticker)?.price ?? NaN);
        if (!Number.isFinite(Number(ref))) ref = Number(rec!.price);
        if (!Number.isFinite(Number(ref))) {
          const q = await getQuote(rec!.ticker);
          if (q != null && Number.isFinite(Number(q))) ref = Number(q);
        }
        if (ref == null || !Number.isFinite(Number(ref))) {
          debug.reasons.push(`force_no_price_for_entry_iter_${i}`);
          await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }

        const cashNum = Number(state.cash);
        const shares = Math.floor(Math.min(cashNum, INVEST_BUDGET) / ref);
        if (shares <= 0) {
          debug.reasons.push(`force_insufficient_cash_for_one_share_ref_${ref.toFixed(2)}`);
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
            entryType: "market",
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

          debug.lastMessage = `✅ 10:15 FORCE BUY (market bracket) ${rec!.ticker} @ ~${ref.toFixed(2)} (shares=${shares})`;
          break;
        } catch (e: any) {
          const msg = e?.message || "unknown";
          const body = e?.body ? JSON.stringify(e.body).slice(0, 300) : "";
          debug.reasons.push(`force_alpaca_submit_failed_iter_${i}:${msg}${body ? " body="+body : ""}`);
          await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
          await new Promise((r) => setTimeout(r, BURST_DELAY_MS));
          continue;
        }
      }
    }

    /** ── End-of-force failsafe: clear stuck lock ── */
    if (!openPos && inEndOfForceFailsafe()) {
      if (state.lastRunDay === yyyyMmDdET()) {
        await prisma.botState.update({ where: { id: 1 }, data: { lastRunDay: null } });
        (debug.reasons as string[]).push("force_failsafe_cleared_day_lock");
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
        scan_0934_1014: inScanWindow(),
        force_1015_1016: inForceWindow(),
        prewarm: inPrewarmWindow(),
        requireAiPick: REQUIRE_AI_PICK,
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
