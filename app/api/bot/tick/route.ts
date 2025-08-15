// app/api/bot/tick/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getQuote } from "@/lib/quote";
import { isWeekdayET, isMarketHoursET, yyyyMmDdET, nowET } from "@/lib/market";
import { submitBracketBuy, closePositionMarket } from "@/lib/alpaca";

/** Throttle */
let lastTickAt = 0;
let lastTickResponse: any = null;
let pendingTick: Promise<any> | null = null;
const MIN_TICK_MS = 500;

/** Config */
const START_CASH = 4000;
const INVEST_BUDGET = 4000;
const TARGET_PCT = 0.10;
const STOP_PCT   = -0.05;
const MAX_SLIPPAGE_PCT = 0.003;
const SNAPSHOT_STALE_MS = 5_000;
const TOP_CANDIDATES    = 8;

/** Windows */
function entryWindowOpenET() { const d = nowET(); const m = d.getHours()*60 + d.getMinutes(); return m >= (9*60 + 34) && m <= (10*60 + 15); }
function isForceBuyMinuteET(){ const d = nowET(); return d.getHours()===10 && d.getMinutes()===15; }
function isMandatoryExitET() { const d = nowET(); const m = d.getHours()*60 + d.getMinutes(); return m >= (15*60 + 55); }

/** Helpers & types */
type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };
type SnapStock = { ticker: string; price?: number|null; changesPercentage?: number|null; volume?: number|null; avgVolume?: number|null; marketCap?: number|null; };

function toET(dateIso: string){ return new Date(new Date(dateIso).toLocaleString("en-US",{ timeZone:"America/New_York"})); }
function isSameETDay(d: Date, ymd: string){ const mo=String(d.getMonth()+1).padStart(2,"0"); const da=String(d.getDate()).padStart(2,"0"); return `${d.getFullYear()}-${mo}-${da}`===ymd; }

async function fetchCandles1m(symbol: string, limit = 240): Promise<Candle[]> {
  const rel = `/api/fmp/candles?symbol=${encodeURIComponent(symbol)}&interval=1min&limit=${limit}`;
  const res = await fetch(rel, { cache: "no-store" });
  if (!res.ok) return [];
  const j = await res.json();
  const arr = Array.isArray(j?.candles) ? j.candles : [];
  return arr.map((c: any) => ({ date:c.date, open:+c.open, high:+c.high, low:+c.low, close:+c.close, volume:+c.volume }));
}

// ---------- typed callbacks below (fixes “implicit any”) ----------
function computeOpeningRange(candles: Candle[], todayYMD: string) {
  const window = candles.filter((c: Candle) => {
    const d = toET(c.date);
    return isSameETDay(d, todayYMD) && d.getHours() === 9 && d.getMinutes() >= 30 && d.getMinutes() <= 34;
  });
  if (!window.length) return null;
  const high = Math.max(...window.map((c: Candle) => c.high));
  const low  = Math.min(...window.map((c: Candle) => c.low));
  return { high, low, count: window.length };
}

function computeSessionVWAP(candles: Candle[], todayYMD: string) {
  const session = candles.filter((c: Candle) => {
    const d = toET(c.date);
    const mins = d.getHours() * 60 + d.getMinutes();
    return isSameETDay(d, todayYMD) && mins >= 9 * 60 + 30;
  });
  if (!session.length) return null;
  let pv = 0, vol = 0;
  for (const c of session) {
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
  }
  return vol > 0 ? pv / vol : null;
}

function computeVolumePulse(candles: Candle[], todayYMD: string, lookback = 5) {
  const dayC = candles.filter((c: Candle) => isSameETDay(toET(c.date), todayYMD));
  if (dayC.length < lookback + 1) return null;
  const latest = dayC[dayC.length - 1];
  const prior  = dayC.slice(-1 - lookback, -1);
  const avgPrior = prior.reduce((sum: number, c: Candle) => sum + c.volume, 0) / lookback;
  if (!avgPrior) return { mult: null as number | null, latestVol: latest.volume, avgPrior };
  return { mult: latest.volume / avgPrior, latestVol: latest.volume, avgPrior };
}

function computeDayHighSoFar(candles: Candle[], todayYMD: string) {
  const day = candles.filter((c: Candle) => isSameETDay(toET(c.date), todayYMD));
  if (day.length < 2) return null;
  const prior = day.slice(0, -1);
  return Math.max(...prior.map((c: Candle) => c.high));
}

function brokeRecentHighs(candles: Candle[], todayYMD: string, n = 3) {
  const day = candles.filter((c: Candle) => isSameETDay(toET(c.date), todayYMD));
  if (day.length < n + 1) return false;
  const last  = day[day.length - 1];
  const prior = day.slice(-1 - n, -1);
  const priorMax = Math.max(...prior.map((c: Candle) => c.high));
  return last.close > priorMax;
}
// -------------------------------------------------------------------

function getBaseUrl(req: Request){ const envBase=process.env.NEXT_PUBLIC_BASE_URL?.trim(); if(envBase) return envBase.replace(/\/+$/,""); const proto=(req.headers.get("x-forwarded-proto")||"http").split(",")[0].trim(); const host=(req.headers.get("x-forwarded-host")||req.headers.get("host")||"").split(",")[0].trim(); return `${proto}://${host}`; }
async function getSnapshot(baseUrl: string){ try{ const r=await fetch(`${baseUrl}/api/stocks/snapshot`,{cache:"no-store"}); if(!r.ok) return null; const j=await r.json(); return {stocks:Array.isArray(j?.stocks)?j.stocks:[], updatedAt:j?.updatedAt||new Date().toISOString()}; } catch { return null; } }

async function ensureTodayRecommendationFromSnapshot(req: Request, top: SnapStock[]){
  const today = yyyyMmDdET();
  let lastRec = await prisma.recommendation.findFirst({ orderBy: { id: "desc" } });
  const recDay = lastRec?.at instanceof Date ? `${lastRec.at.getFullYear()}-${String(lastRec.at.getMonth()+1).padStart(2,"0")}-${String(lastRec.at.getDate()).padStart(2,"0")}` : null;
  if (lastRec && recDay === today) return lastRec;
  if (!entryWindowOpenET() || !top.length) return lastRec || null;

  try{
    const base = getBaseUrl(req);
    const rRes = await fetch(`${base}/api/recommendation`, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ stocks: top }), cache:"no-store" });
    if (!rRes.ok) return lastRec || null;
    const rJson = await rRes.json();
    const txt: string = rJson?.recommendation || "";
    const m = /Pick:\s*([A-Z][A-Z0-9.\-]*)/i.exec(txt);
    const ticker = m?.[1]?.toUpperCase() || null;
    if (!ticker) return lastRec || null;

    const priceCandidate = top.find((s: SnapStock) => s.ticker === ticker)?.price ?? (await getQuote(ticker));
    if (priceCandidate == null || !Number.isFinite(Number(priceCandidate))) return lastRec || null;

    lastRec = await prisma.recommendation.create({ data: { ticker, price: Number(priceCandidate) } });
    return lastRec;
  } catch { return lastRec || null; }
}

export async function GET(req: Request){ return handle(req); }
export async function POST(req: Request){ return handle(req); }

async function handle(req: Request){
  const now = Date.now();
  if (pendingTick){ const data = await pendingTick; return NextResponse.json(data); }
  if (lastTickResponse && now - lastTickAt < MIN_TICK_MS) return NextResponse.json(lastTickResponse);

  pendingTick = (async () => {
    const debug: any = { reasons: [] as string[] };

    // Ensure state
    let state = await prisma.botState.findUnique({ where: { id: 1 } });
    if (!state) state = await prisma.botState.create({ data: { id: 1, cash: START_CASH, pnl: 0, equity: START_CASH } });

    let openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
    let lastRec = await prisma.recommendation.findFirst({ orderBy: { id: "desc" } });
    let livePrice: number | null = null;
    const today = yyyyMmDdET();

    // ---------- Mandatory exit (>= 15:55 ET) ----------
    if (openPos && isMandatoryExitET()) {
      const exitTicker = openPos.ticker; // capture before nulling
      try {
        await closePositionMarket(exitTicker);
        const pQuote = await getQuote(exitTicker);
        const p = (pQuote != null && Number.isFinite(Number(pQuote))) ? Number(pQuote) : Number(openPos.entryPrice);

        const exitVal  = Number(openPos.shares) * p;
        const entry    = Number(openPos.entryPrice);
        const realized = exitVal - Number(openPos.shares) * entry;

        await prisma.trade.create({ data: { side: "SELL", ticker: exitTicker, price: p, shares: openPos.shares } });
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

    if (!isWeekdayET()) {
      debug.reasons.push("not_weekday");
      return { state, lastRec, position: openPos, live: null, serverTimeET: nowET().toISOString(), skipped: "not_weekday", debug };
    }
    const marketOpen = isMarketHoursET();

    // Snapshot
    const base = getBaseUrl(req);
    const snapshot = await getSnapshot(base);
    if (!openPos && (!snapshot?.stocks?.length || (Date.now() - new Date(snapshot?.updatedAt || 0).getTime()) > SNAPSHOT_STALE_MS)) {
      debug.reasons.push("no_or_stale_snapshot");
      return { state, lastRec, position: openPos, live: null, serverTimeET: nowET().toISOString(), skipped: "no_or_stale_snapshot", debug };
    }
    const top8: SnapStock[] = (snapshot?.stocks || []).slice(0, TOP_CANDIDATES);

    // Live price for UI
    const liveTicker: string | null = openPos ? openPos.ticker : lastRec ? (lastRec as any).ticker : null;
    if (liveTicker) {
      const s = snapshot?.stocks?.find((x: SnapStock) => x.ticker === liveTicker);
      livePrice = (s?.price != null && Number.isFinite(Number(s.price))) ? Number(s.price) : (await getQuote(liveTicker) ?? null) as any;
      if (typeof livePrice === "string") livePrice = Number(livePrice);
    }

    const inEntryWindow = entryWindowOpenET();

    // Ensure same-day AI pick
    if (!openPos && inEntryWindow && (!lastRec || !isSameETDay(lastRec.at ?? new Date(), today))) {
      lastRec = await ensureTodayRecommendationFromSnapshot(req, top8);
    }

    // ---------- Entry (1/day) ----------
    if (!openPos && inEntryWindow && marketOpen && (state.lastRunDay !== today) && lastRec?.ticker) {
      try {
        const candles = await fetchCandles1m(lastRec.ticker, 240);
        const day = candles.filter((c: Candle) => isSameETDay(toET(c.date), today));
        if (day.length) {
          const orRange = computeOpeningRange(candles, today);
          const vwap    = computeSessionVWAP(candles, today);
          const vol     = computeVolumePulse(candles, today, 5);
          const last    = day[day.length-1];
          const dayHigh = computeDayHighSoFar(candles, today);

          const aboveVWAP = vwap != null && last ? last.close >= vwap : false;
          const brokeOR   = !!(orRange && last && last.close > orRange.high);
          const pullback  = !!(orRange && last && last.low >= orRange.high * 0.985);
          const brokeDay  = (typeof dayHigh === "number" && last) ? last.close > dayHigh : brokeOR;
          const broke3    = brokeRecentHighs(candles, today, 3);
          const volOK     = (vol?.mult ?? 0) >= 1.1;

          const armed = aboveVWAP && volOK && ((brokeOR && pullback) || brokeDay || broke3);

          if (armed || isForceBuyMinuteET()) {
            // lock 1/day
            const claim = await prisma.botState.updateMany({
              where: { id: 1, OR: [{ lastRunDay: null }, { lastRunDay: { not: today } }] },
              data: { lastRunDay: today },
            });
            const claimed = claim.count === 1;

            if (claimed) {
              openPos = await prisma.position.findFirst({ where: { open: true }, orderBy: { id: "desc" } });
              if (!openPos) {
                // price source: snapshot -> rec.price -> live quote
                let entryRefPrice: number | null =
                  Number(snapshot?.stocks?.find((s: SnapStock) => s.ticker === lastRec!.ticker)?.price ?? NaN);
                if (!Number.isFinite(entryRefPrice)) entryRefPrice = Number(lastRec!.price);
                if (!Number.isFinite(entryRefPrice)) {
                  const q = await getQuote(lastRec!.ticker); if (q != null && Number.isFinite(Number(q))) entryRefPrice = Number(q);
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
                    // Place Alpaca bracket
                    const order = await submitBracketBuy({ symbol: lastRec.ticker, qty: shares, limit, tp, sl, tif: "day" });

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
                      data: { cash: cashNum - used, equity: cashNum - used + shares * (livePrice ?? limit) },
                    });
                  }
                }
              }
            }
          }
        }
      } catch (e: any) {
        console.error("entry evaluation error", e?.message || e);
      }
    }

    // ---------- Holding (refresh equity) ----------
    if (openPos) {
      let p: number | null = null;
      const s = snapshot?.stocks?.find((x: SnapStock) => x.ticker === openPos!.ticker);
      if (s?.price != null && Number.isFinite(Number(s.price))) p = Number(s.price);
      else { const q = await getQuote(openPos.ticker); if (q != null && Number.isFinite(Number(q))) p = Number(q); }
      if (p != null) {
        const equityNow = Number(state.cash) + Number(openPos.shares) * p;
        if (Number(state.equity) !== equityNow) {
          state = await prisma.botState.update({ where: { id: 1 }, data: { equity: equityNow } });
        }
      }
    }

    return {
      state,
      lastRec,
      position: openPos,
      live: { ticker: liveTicker, price: livePrice },
      serverTimeET: nowET().toISOString(),
      info: {
        entryWindowOpen_0934_1015: entryWindowOpenET(),
        isForceBuyMinute_1015: isForceBuyMinuteET(),
        isMandatoryExit_1555: isMandatoryExitET(),
        snapshotAgeMs: snapshot ? (Date.now() - new Date(snapshot.updatedAt).getTime()) : null,
        investBudget: INVEST_BUDGET,
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
