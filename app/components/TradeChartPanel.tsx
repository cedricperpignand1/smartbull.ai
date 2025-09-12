"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/* ============= Types ============= */
type Candle = {
  date: string; open: number; high: number; low: number; close: number; volume: number;
};
type PositionWire = {
  open: boolean; ticker: string | null; shares: number | null;
  entryPrice: number | null; entryAt: string | null; stopLoss: number | null; takeProfit: number | null; error?: string;
};
type TradeWire = { side: "BUY" | "SELL" | string; ticker: string; price: number; shares: number; at: string };

/* ============= Time utils ============= */
const toSec = (ts: string | number | Date) =>
  Math.floor((typeof ts === "string" ? new Date(ts).getTime() : ts instanceof Date ? ts.getTime() : ts) / 1000);
const toET = (d: Date) => new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
const isSameETDay = (d: Date, ymd: string) => {
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}` === ymd;
};
function yyyyMmDdET(nowUTC = new Date()) {
  const et = toET(nowUTC);
  const mo = String(et.getMonth() + 1).padStart(2, "0");
  const da = String(et.getDate()).padStart(2, "0");
  return `${et.getFullYear()}-${mo}-${da}`;
}
const isMarketHoursET = (nowUTC = new Date()) => {
  const et = toET(nowUTC); const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
};
const isBeforeETClose = (nowUTC = new Date()) => {
  const et = toET(nowUTC); const mins = et.getHours() * 60 + et.getMinutes();
  return mins <= 16 * 60;
};

/* ============= VWAP ============= */
function computeSessionVWAP(candles: Candle[], dayYMD: string) {
  let pv = 0, vol = 0; const out: { time: number; value: number }[] = [];
  for (const c of candles) {
    const d = toET(new Date(c.date)); const mins = d.getHours() * 60 + d.getMinutes();
    if (!isSameETDay(d, dayYMD) || mins < 9 * 60 + 30) continue;
    const h = +c.high, l = +c.low, cl = +c.close, v = +c.volume;
    if (![h, l, cl, v].every(Number.isFinite)) continue;
    const typical = (h + l + cl) / 3; pv += typical * v; vol += v;
    if (vol > 0) out.push({ time: toSec(c.date), value: pv / vol });
  }
  return out;
}

/* ============= Data helpers ============= */
function useVisibility() {
  const [visible, setVisible] = useState(true);
  useEffect(() => { const on = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", on); return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}
async function fetchJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" }); if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

const POS_EMPTY: PositionWire = { open: false, ticker: null, shares: null, entryPrice: null, entryAt: null, stopLoss: null, takeProfit: null };

function useOpenPosition(pollMsWhileOpen = 20000) {
  const visible = useVisibility(); const [pos, setPos] = useState<PositionWire | null>(null);
  async function refresh() {
    try { setPos(await fetchJSON<PositionWire>("/api/positions/open")); }
    catch { setPos(POS_EMPTY); console.warn("[TradeChartPanel] /api/positions/open failed"); }
  }
  useEffect(() => { refresh(); }, []);
  useEffect(() => { if (!visible) return; const id = setInterval(refresh, pollMsWhileOpen); return () => clearInterval(id); },
    [visible, pollMsWhileOpen]);
  return pos;
}

function useTodayTrades(symbol: string | null, pollMsWhenActive = 30000) {
  const visible = useVisibility(); const [rows, setRows] = useState<TradeWire[] | null>(null);
  const toYMD = (d: Date) => {
    const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
    return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
  };
  async function load() {
    if (!symbol) return; const enc = encodeURIComponent(symbol);
    const urls = [
      `/api/trades/today?symbol=${enc}`,
      `/api/trades?symbol=${enc}&today=1`,
      `/api/trades?symbol=${enc}`,
      `/api/trades`,
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { cache: "no-store" }); if (!r.ok) continue; const j = await r.json();
        const raw: any[] = Array.isArray(j) ? j : Array.isArray(j?.trades) ? j.trades : []; if (!raw.length) continue;
        const todayKey = toYMD(new Date());
        const norm: TradeWire[] = raw.map((t: any) => ({
          side: String(t.side ?? t.type ?? "").toUpperCase(),
          ticker: String(t.ticker ?? t.symbol ?? "").toUpperCase(),
          price: Number(t.price ?? t.p ?? t.fill_price),
          shares: Number(t.shares ?? t.qty ?? t.quantity),
          at: String(t.at ?? t.time ?? t.createdAt ?? t.filledAt ?? t.executedAt ?? ""),
        })).filter((t) => t.ticker === symbol.toUpperCase() &&
                           toYMD(new Date(t.at)) === todayKey);
        setRows(norm); return;
      } catch {}
    }
    if (rows == null) setRows([]);
  }
  useEffect(() => { setRows(null); if (symbol) load(); }, [symbol]);
  useEffect(() => { if (!symbol || !visible || !isMarketHoursET()) return;
    const id = setInterval(load, pollMsWhenActive); return () => clearInterval(id);
  }, [symbol, visible, pollMsWhenActive]);
  return rows;
}

function useCandles1m(symbol: string | null, isActiveFast: boolean, pollMsFast = 30000, pollMsSlow = 120000, limit = 240) {
  const visible = useVisibility(); const [candles, setCandles] = useState<Candle[] | null>(null);

  async function fetchCandles(sym: string) {
    const enc = encodeURIComponent(sym);
    const urls = [
      `/api/fmp/candles?ticker=${enc}&symbol=${enc}&interval=1min&limit=${limit}`,
      `/api/fmp/bars?ticker=${enc}&symbol=${enc}&tf=1min&limit=${limit}`,
      `/api/stocks/candles?ticker=${enc}&interval=1min&limit=${limit}`,
      `/api/candles?ticker=${enc}&interval=1min&limit=${limit}`,
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { cache: "no-store" }); if (!r.ok) continue; const data = await r.json();
        const raw: any[] = Array.isArray(data) ? data : Array.isArray(data?.candles) ? data.candles : Array.isArray(data?.bars) ? data.bars : [];
        if (!raw.length) continue;
        const clean: Candle[] = raw.map((k: any) => ({
          date: String(k.date ?? k.time ?? k.t ?? ""),
          open: Number(k.open ?? k.o),
          high: Number(k.high ?? k.h),
          low: Number(k.low ?? k.l),
          close: Number(k.close ?? k.c),
          volume: Number(k.volume ?? k.v),
        })).filter(k => !!k.date && [k.open,k.high,k.low,k.close,k.volume].every(Number.isFinite));
        if (clean.length) return clean;
      } catch {}
    }
    return [];
  }

  async function load(sym: string) { const out = await fetchCandles(sym); if (out.length) setCandles(out); }
  useEffect(() => { setCandles(null); if (symbol) load(symbol); }, [symbol]);
  useEffect(() => {
    if (!symbol || !visible || !isMarketHoursET()) return;
    const ms = isActiveFast ? pollMsFast : pollMsSlow; const id = setInterval(() => load(symbol), ms);
    return () => clearInterval(id);
  }, [symbol, isActiveFast, visible, pollMsFast, pollMsSlow]);

  return { candles };
}

/* ============= Lightweight-charts loader (ESM → CDN fallback) ============= */
declare global { interface Window { LightweightCharts?: any } }

type LW = { createChart: any; CrosshairMode: any; ColorType: any };

async function loadLWFromModule(): Promise<LW | null> {
  try {
    const m: any = await import("lightweight-charts");
    const root = m?.createChart ? m : m?.default;
    if (!root?.createChart) return null;
    return { createChart: root.createChart, CrosshairMode: root.CrosshairMode, ColorType: root.ColorType };
  } catch { return null; }
}

function loadLWFromCDN(version = "4.2.0"): Promise<LW | null> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve(null);
    if (window.LightweightCharts?.createChart) {
      const g = window.LightweightCharts;
      return resolve({ createChart: g.createChart, CrosshairMode: g.CrosshairMode, ColorType: g.ColorType });
    }
    const s = document.createElement("script");
    s.src = `https://unpkg.com/lightweight-charts@${version}/dist/lightweight-charts.standalone.production.js`;
    s.async = true;
    s.onload = () => {
      const g = window.LightweightCharts;
      resolve(g?.createChart ? { createChart: g.createChart, CrosshairMode: g.CrosshairMode, ColorType: g.ColorType } : null);
    };
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
}

async function loadLWAny(): Promise<LW | null> {
  return (await loadLWFromModule()) || (await loadLWFromCDN());
}

/* ============= Component ============= */
export default function TradeChartPanel({ height = 360, symbolWhenFlat }: { height?: number; symbolWhenFlat?: string | null | undefined }) {
  const pos = useOpenPosition(20000);

  // 4pm ET gate for fallback
  const [beforeCloseFlag, setBeforeCloseFlag] = useState(isBeforeETClose());
  useEffect(() => { const id = setInterval(() => setBeforeCloseFlag(isBeforeETClose()), 60_000); return () => clearInterval(id); }, []);

  // sticky symbol for the day
  const dayYMD = useMemo(() => yyyyMmDdET(new Date()), []);
  const [stickySymbol, setStickySymbol] = useState<string | null>(null);
  const [stickyDay, setStickyDay] = useState<string | null>(null);
  useEffect(() => {
    try {
      const s = sessionStorage.getItem("chartSticky");
      if (s) {
        const obj = JSON.parse(s);
        if (obj?.symbol && obj?.day === dayYMD && isBeforeETClose()) { setStickySymbol(obj.symbol); setStickyDay(obj.day); }
      }
    } catch {}
  }, [dayYMD]);
  const hasOpen = !!pos?.open && !!pos?.ticker;
  useEffect(() => {
    if (!hasOpen) return;
    const t = String(pos!.ticker);
    setStickySymbol(t); setStickyDay(dayYMD);
    try { sessionStorage.setItem("chartSticky", JSON.stringify({ symbol: t, day: dayYMD })); } catch {}
  }, [hasOpen, pos?.ticker, dayYMD]);
  useEffect(() => {
    const id = setInterval(() => {
      if (!isBeforeETClose() && stickySymbol) { setStickySymbol(null); setStickyDay(null); try { sessionStorage.removeItem("chartSticky"); } catch {} }
    }, 60_000);
    return () => clearInterval(id);
  }, [stickySymbol]);

  const stickyActive = !!stickySymbol && stickyDay === dayYMD && beforeCloseFlag;
  const symbol: string | null =
    hasOpen ? (pos!.ticker as string) : stickyActive ? stickySymbol : beforeCloseFlag && symbolWhenFlat ? String(symbolWhenFlat) : null;

  const { candles } = useCandles1m(symbol, hasOpen || stickyActive, 30000, 120000, 240);
  const todayTrades = useTodayTrades(symbol, 30000);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<any>(null);
  const candleSeriesRef = useRef<any>(null);
  const vwapSeriesRef = useRef<any>(null);
  const priceLinesRef = useRef<any[]>([]);
  const [hover, setHover] = useState<{ price?: number; o?: number; h?: number; l?: number; c?: number; vwap?: number } | null>(null);

  // debug
  useEffect(() => { console.log("[TradeChartPanel] symbol:", symbol, "candles:", candles?.length ?? 0); }, [symbol, candles?.length]);

  // create chart (ESM → CDN)
  useEffect(() => {
    let cleanup = () => {};
    (async () => {
      if (!containerRef.current) return;
      const lw = await loadLWAny();
      if (!lw) { console.error("[TradeChartPanel] lightweight-charts not available"); return; }

      const chart = lw.createChart(containerRef.current, {
        height,
        layout: { textColor: "#e5e7eb", background: { type: lw.ColorType?.Solid ?? 0, color: "#0b1220" } },
        grid: { vertLines: { visible: false }, horzLines: { visible: true, color: "#1f2a44" } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
        crosshair: { mode: lw.CrosshairMode?.Normal ?? 0 },
      });

      const candleSeries = chart.addCandlestickSeries({});
      candleSeries.applyOptions({
        upColor: "#22c55e", downColor: "#ef4444", wickUpColor: "#22c55e", wickDownColor: "#ef4444", borderVisible: false,
      });

      let vwapSeries: any = null;
      try { vwapSeries = chart.addLineSeries({}); vwapSeries.applyOptions({ lineWidth: 2 }); } catch {}

      const onMove = (p: any) => {
        if (!p?.time) { setHover(null); return; }
        const sd = p.seriesData as Map<any, any>;
        const c = sd?.get(candleSeries); const v = vwapSeries ? sd?.get(vwapSeries) : null;
        if (!c) { setHover(null); return; }
        setHover({ o: c.open, h: c.high, l: c.low, c: c.close, price: c.close, vwap: typeof v?.value === "number" ? v.value : undefined });
      };
      chart.subscribeCrosshairMove(onMove);

      chartRef.current = chart; candleSeriesRef.current = candleSeries; vwapSeriesRef.current = vwapSeries;

      const applyWidth = () => { if (!containerRef.current) return; chart.applyOptions({ width: containerRef.current.clientWidth }); };
      applyWidth(); const ro = new ResizeObserver(applyWidth); ro.observe(containerRef.current!);
      const onWinResize = () => applyWidth(); window.addEventListener("resize", onWinResize);

      cleanup = () => { window.removeEventListener("resize", onWinResize); ro.disconnect(); chart.unsubscribeCrosshairMove(onMove); chart.remove(); };
    })();

    return () => cleanup();
  }, [height]);

  // update series with data + lines/markers
  useEffect(() => {
    const cs = candleSeriesRef.current, vs = vwapSeriesRef.current, chart = chartRef.current;
    if (!cs || !chart) return;

    for (const pl of priceLinesRef.current) { try { cs.removePriceLine(pl); } catch {} }
    priceLinesRef.current = [];

    if (!candles?.length) { cs.setData([]); try { vs?.setData?.([]); } catch {} cs.setMarkers([]); return; }

    const seriesData = candles.map((c) => ({ time: toSec(c.date), open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
    cs.setData(seriesData);

    if (vs) { const vwap = computeSessionVWAP(candles, yyyyMmDdET(new Date())); vs.setData(Array.isArray(vwap) ? vwap : []); }
    chart.timeScale().fitContent();

    const isOpen = !!pos?.open && !!pos?.ticker;
    const entryPrice = isOpen ? (pos?.entryPrice ?? null) : null;
    const stopLoss = isOpen ? (pos?.stopLoss ?? null) : null;
    const takeProfit = isOpen ? (pos?.takeProfit ?? null) : null;
    const entryAt = isOpen && pos?.entryAt ? toSec(pos.entryAt) : null;

    let markerTime = entryAt;
    if (entryAt && seriesData.length) {
      let best = seriesData[0].time as number, bestDiff = Math.abs(best - entryAt);
      for (const pt of seriesData) { const diff = Math.abs((pt.time as number) - entryAt);
        if (diff < bestDiff) { best = pt.time as number; bestDiff = diff; } }
      markerTime = best;
    }

    const markers: any[] = [];
    if (entryPrice != null) {
      const pl = cs.createPriceLine({ price: entryPrice, title: "Entry", lineWidth: 1, color: "#9ca3af" }); priceLinesRef.current.push(pl);
      if (markerTime) markers.push({ time: markerTime, position: "belowBar", color: "#9ca3af", shape: "arrowUp", text: "Entry" });
    }
    if (stopLoss != null) {
      const pl = cs.createPriceLine({ price: stopLoss, title: "Stop", lineWidth: 1, color: "#ef4444" }); priceLinesRef.current.push(pl);
      if (markerTime) markers.push({ time: markerTime, position: "aboveBar", color: "#ef4444", shape: "arrowDown", text: "SL" });
    }
    if (takeProfit != null) {
      const pl = cs.createPriceLine({ price: takeProfit, title: "Target", lineWidth: 1, color: "#22c55e" }); priceLinesRef.current.push(pl);
      if (markerTime) markers.push({ time: markerTime, position: "belowBar", color: "#22c55e", shape: "arrowUp", text: "TP" });
    }

    if (Array.isArray(todayTrades) && todayTrades.length) {
      const sells = todayTrades.filter((t) => String(t.side).toUpperCase() === "SELL");
      if (sells.length) {
        const totalSold = sells.reduce((s, r) => s + (+r.shares || 0), 0);
        const wAvgExit = totalSold > 0 ? sells.reduce((s, r) => s + (+r.price || 0) * (+r.shares || 0), 0) / totalSold : null;
        if (wAvgExit != null && Number.isFinite(wAvgExit)) {
          const pl = cs.createPriceLine({ price: wAvgExit, title: "Exit avg", lineWidth: 1, color: "#f59e0b" });
          priceLinesRef.current.push(pl);
        }
        for (const s of sells) {
          const t = toSec(s.at);
          let best = seriesData[0].time as number, bestDiff = Math.abs(best - t);
          for (const pt of seriesData) { const diff = Math.abs((pt.time as number) - t); if (diff < bestDiff) { best = pt.time as number; bestDiff = diff; } }
          markers.push({ time: best, position: "aboveBar", color: "#f59e0b", shape: "arrowDown", text: `Exit ${s.shares}` });
        }
      }
    }

    cs.setMarkers(markers);
  }, [candles, todayTrades, pos?.entryPrice, pos?.stopLoss, pos?.takeProfit, pos?.entryAt, pos?.open, pos?.ticker]);

  // R:R legend
  const rr = useMemo(() => {
    if (!(pos?.open && pos?.entryPrice && pos?.stopLoss)) return null;
    const risk = Math.abs(pos.entryPrice - pos.stopLoss); if (risk <= 0) return null;
    const p = hover?.price; if (p == null) return null; const tp = pos.takeProfit ?? undefined;
    return { rToStop: (p - pos.stopLoss) / risk, rToTP: tp != null ? (tp - p) / risk : undefined };
  }, [hover?.price, pos?.entryPrice, pos?.stopLoss, pos?.takeProfit, pos?.open]);

  // use the already-computed symbol to drive UI (no re-declarations)
  const showChart = !!symbol;
  const headerLeft = showChart ? `${symbol} • 1-min • VWAP` : "1-min Chart";

  return (
    <div className="w-full">
      <div className="relative rounded-2xl border border-slate-700 bg-slate-900/70 shadow p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-slate-200 font-medium">{headerLeft}</div>
          {hasOpen && pos?.entryPrice != null ? (
            <div className="text-xs text-slate-400">
              Entry <span className="text-slate-200">${Number(pos.entryPrice).toFixed(2)}</span>
              {pos.stopLoss != null && (<><span className="mx-2">•</span>SL <span className="text-red-400">${Number(pos.stopLoss).toFixed(2)}</span></>)}
              {pos.takeProfit != null && (<><span className="mx-2">•</span>TP <span className="text-green-400">${Number(pos.takeProfit).toFixed(2)}</span></>)}
            </div>
          ) : stickyActive ? (
            <div className="text-xs text-slate-400 italic">Position closed — showing last chart until 4:00 PM ET.</div>
          ) : null}
        </div>

        {showChart ? (
          <>
            <div ref={containerRef} className="w-full" style={{ height }} />
            <div className="pointer-events-none absolute right-3 top-3 rounded-md bg-slate-800/80 px-3 py-2 text-[11px] leading-4 text-slate-200">
              {hover ? (
                <>
                  <div>O {hover.o?.toFixed(2)} H {hover.h?.toFixed(2)} L {hover.l?.toFixed(2)} C {hover.c?.toFixed(2)}</div>
                  <div>VWAP {hover.vwap != null ? hover.vwap.toFixed(2) : "—"}</div>
                  {rr ? (<div className="text-slate-300">R→SL {rr.rToStop.toFixed(2)}x{rr.rToTP != null ? ` • R→TP ${rr.rToTP.toFixed(2)}x` : ""}</div>)
                      : (<div className="text-slate-500">R:R —</div>)}
                </>
              ) : (<div className="text-slate-400">Hover for OHLC / VWAP</div>)}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-[260px] md:h-[300px]">
            <div className="text-slate-400 text-sm">No open positions yet. I’ll pop a live 1-min chart here when we enter.</div>
          </div>
        )}
      </div>
    </div>
  );
}
