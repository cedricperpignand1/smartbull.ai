"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/* ───────────────── Types ───────────────── */
type Candle = {
  date: string; // ISO
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type PositionWire = {
  open: boolean;
  ticker: string | null;
  shares: number | null;
  entryPrice: number | null;
  entryAt: string | null; // ISO
  stopLoss: number | null;
  takeProfit: number | null;
};

type TradeWire = {
  side: "BUY" | "SELL" | string;
  ticker: string;
  price: number;
  shares: number;
  at: string; // ISO
};

/* ───────────────── Time utils ───────────────── */
function toSec(ts: string | number | Date) {
  const t = typeof ts === "string" ? new Date(ts).getTime() : ts instanceof Date ? ts.getTime() : ts;
  return Math.floor(t / 1000);
}
function toET(d: Date) {
  return new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
}
function isSameETDay(d: Date, ymd: string) {
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}` === ymd;
}
function yyyyMmDdET(nowUTC = new Date()) {
  const et = toET(nowUTC);
  const mo = String(et.getMonth() + 1).padStart(2, "0");
  const da = String(et.getDate()).padStart(2, "0");
  return `${et.getFullYear()}-${mo}-${da}`;
}
function isMarketHoursET(nowUTC = new Date()) {
  const et = toET(nowUTC);
  const mins = et.getHours() * 60 + et.getMinutes();
  // 9:30–16:00 ET
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}
/** Before/at 4:00pm ET for *today* */
function isBeforeETClose(nowUTC = new Date()) {
  const et = toET(nowUTC);
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins <= 16 * 60;
}

/** Cumulative session VWAP (from 9:30 ET forward) */
function computeSessionVWAP(candles: Candle[], dayYMD: string) {
  let pv = 0;
  let vol = 0;
  const out: { time: number; value: number }[] = [];
  for (const c of candles) {
    const d = toET(new Date(c.date));
    const mins = d.getHours() * 60 + d.getMinutes();
    if (!isSameETDay(d, dayYMD)) continue;
    if (mins < 9 * 60 + 30) continue;
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
    if (vol > 0) out.push({ time: toSec(c.date), value: pv / vol });
  }
  return out;
}

/* ───────────────── Data fetching helpers ───────────────── */
function useVisibility() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const onVis = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  return visible;
}
async function fetchJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** Poll open position lightly (pauses when tab hidden). */
function useOpenPosition(pollMsWhileOpen = 20000) {
  const visible = useVisibility();
  const [pos, setPos] = useState<PositionWire | null>(null);

  async function refresh() {
    try {
      const data = await fetchJSON<PositionWire>("/api/positions/open");
      setPos(data);
    } catch {}
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const id = setInterval(refresh, pollMsWhileOpen);
    return () => clearInterval(id);
  }, [visible, pollMsWhileOpen]);

  return pos;
}

/** Today’s trades for a symbol (for exit markers/avg). */
function useTodayTrades(symbol: string | null, pollMsWhenActive = 30000) {
  const visible = useVisibility();
  const [rows, setRows] = useState<TradeWire[] | null>(null);

  async function load() {
    if (!symbol) return;
    try {
      const j = await fetchJSON<{ trades: TradeWire[] }>(`/api/trades/today?symbol=${encodeURIComponent(symbol)}`);
      setRows(Array.isArray(j?.trades) ? j.trades : []);
    } catch {}
  }

  // Initial load
  useEffect(() => {
    setRows(null);
    if (symbol) load();
  }, [symbol]);

  // Poll only if market hours + visible (conservative)
  useEffect(() => {
    if (!symbol) return;
    if (!visible) return;
    if (!isMarketHoursET()) return;
    const id = setInterval(load, pollMsWhenActive);
    return () => clearInterval(id);
  }, [symbol, visible, pollMsWhenActive]);

  return rows;
}

/** 1m candles: poll fast when “active” (open or sticky), slow when not; pause when hidden/outside hours. */
function useCandles1m(symbol: string | null, isActiveFast: boolean, pollMsFast = 30000, pollMsSlow = 120000, limit = 240) {
  const visible = useVisibility();
  const [candles, setCandles] = useState<Candle[] | null>(null);

  const url = symbol
    ? `/api/fmp/candles?symbol=${encodeURIComponent(symbol)}&interval=1min&limit=${limit}`
    : null;

  async function load() {
    if (!url) return;
    try {
      const data = await fetchJSON<{ candles: Candle[] }>(url);
      setCandles(Array.isArray((data as any).candles) ? (data as any).candles : []);
    } catch {}
  }

  // initial fetch
  useEffect(() => {
    setCandles(null);
    if (symbol) load();
  }, [symbol]);

  // polling
  useEffect(() => {
    if (!symbol) return;
    if (!visible) return;
    if (!isMarketHoursET()) return;

    const ms = isActiveFast ? pollMsFast : pollMsSlow;
    const id = setInterval(load, ms);
    return () => clearInterval(id);
  }, [symbol, isActiveFast, visible, pollMsFast, pollMsSlow]);

  return { candles };
}

/* ───────────────── Main component ───────────────── */
export default function TradeChartPanel({
  height = 360,
  symbolWhenFlat, // optional fallback when there's never been an entry today
}: {
  height?: number;
  symbolWhenFlat?: string;
}) {
  const pos = useOpenPosition(20000);

  // ── Sticky-until-close state (persists for the day in sessionStorage)
  const dayYMD = useMemo(() => yyyyMmDdET(new Date()), []);
  const [stickySymbol, setStickySymbol] = useState<string | null>(null);
  const [stickyDay, setStickyDay] = useState<string | null>(null);

  // restore sticky from this tab’s session, if same ET day & before close
  useEffect(() => {
    try {
      const s = sessionStorage.getItem("chartSticky");
      if (s) {
        const obj = JSON.parse(s);
        if (obj?.symbol && obj?.day === dayYMD && isBeforeETClose()) {
          setStickySymbol(obj.symbol);
          setStickyDay(obj.day);
        }
      }
    } catch {}
  }, [dayYMD]);

  // when we FIRST observe an open position today, start sticky until 16:00 ET
  const hasOpen = !!pos?.open && !!pos?.ticker;
  useEffect(() => {
    if (!hasOpen) return;
    const t = String(pos!.ticker);
    setStickySymbol(t);
    setStickyDay(dayYMD);
    try {
      sessionStorage.setItem("chartSticky", JSON.stringify({ symbol: t, day: dayYMD }));
    } catch {}
  }, [hasOpen, pos?.ticker, dayYMD]);

  // after 4:00pm ET, drop sticky and clean storage
  useEffect(() => {
    const id = setInterval(() => {
      if (!isBeforeETClose() && stickySymbol) {
        setStickySymbol(null);
        setStickyDay(null);
        try { sessionStorage.removeItem("chartSticky"); } catch {}
      }
    }, 60_000);
    return () => clearInterval(id);
  }, [stickySymbol]);

  // which symbol to display:
  //  - if open → current position
  //  - else if sticky for today & before 4pm → that ticker
  //  - else, optional fallback (symbolWhenFlat), otherwise empty (placeholder)
  const stickyActive = !!stickySymbol && stickyDay === dayYMD && isBeforeETClose();
  const symbol: string | null = hasOpen
    ? (pos!.ticker as string)
    : stickyActive
    ? stickySymbol
    : symbolWhenFlat
    ? symbolWhenFlat
    : null;

  // data
  const { candles } = useCandles1m(symbol, hasOpen || stickyActive, 30000, 120000, 240);
  const todayTrades = useTodayTrades(symbol, 30000);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<any>(null);
  const candleSeriesRef = useRef<any>(null);
  const vwapSeriesRef = useRef<any>(null);
  const priceLinesRef = useRef<any[]>([]);
  const [hover, setHover] = useState<{ price?: number; o?: number; h?: number; l?: number; c?: number; vwap?: number } | null>(null);

  // Create chart (compat shim v4/v5)
  useEffect(() => {
    let cleanup = () => {};
    let destroyed = false;

    (async () => {
      if (!containerRef.current) return;
      const lc = await import("lightweight-charts");
      if (destroyed) return;

      const chart = lc.createChart(containerRef.current, {
        height,
        layout: { textColor: "#e5e7eb", background: { type: lc.ColorType.Solid, color: "#0b1220" } },
        grid: { vertLines: { visible: false }, horzLines: { visible: true, color: "#1f2a44" } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
        crosshair: { mode: lc.CrosshairMode.Normal },
      });

      const anyChart = chart as any;

      // Candles
      let candleSeries: any;
      if (typeof anyChart.addCandlestickSeries === "function") {
        candleSeries = anyChart.addCandlestickSeries({});
      } else if (typeof anyChart.addSeries === "function") {
        try { candleSeries = anyChart.addSeries({ type: "Candlestick" }); } catch { candleSeries = anyChart.addSeries("Candlestick"); }
      } else { throw new Error("No addSeries"); }
      candleSeries.applyOptions({
        upColor: "#22c55e",
        downColor: "#ef4444",
        wickUpColor: "#22c55e",
        wickDownColor: "#ef4444",
        borderVisible: false,
      });

      // VWAP line
      let vwapSeries: any;
      if (typeof anyChart.addLineSeries === "function") {
        vwapSeries = anyChart.addLineSeries({});
      } else {
        try { vwapSeries = anyChart.addSeries({ type: "Line" }); } catch { vwapSeries = anyChart.addSeries("Line"); }
      }
      vwapSeries.applyOptions({ lineWidth: 2 });

      // Legend: crosshair move
      const onMove = (p: any) => {
        if (!p?.time) { setHover(null); return; }
        const sd = p.seriesData as Map<any, any>;
        const c = sd?.get(candleSeries);
        const v = sd?.get(vwapSeries);
        if (!c) { setHover(null); return; }
        setHover({
          o: c.open, h: c.high, l: c.low, c: c.close,
          price: c.close,
          vwap: typeof v?.value === "number" ? v.value : undefined,
        });
      };
      chart.subscribeCrosshairMove(onMove);

      chartRef.current = chart;
      candleSeriesRef.current = candleSeries;
      vwapSeriesRef.current = vwapSeries;

      const resize = () => {
        if (!containerRef.current) return;
        chart.applyOptions({ width: containerRef.current.clientWidth });
      };
      resize();
      window.addEventListener("resize", resize);
      cleanup = () => {
        window.removeEventListener("resize", resize);
        chart.unsubscribeCrosshairMove(onMove);
        chart.remove();
      };
    })();

    return () => { destroyed = true; cleanup(); };
  }, [height]);

  // Update series when data changes (candles + markers + lines)
  useEffect(() => {
    const cs = candleSeriesRef.current;
    const vs = vwapSeriesRef.current;
    const chart = chartRef.current;
    if (!cs || !vs || !chart) return;

    // clear old price lines
    for (const pl of priceLinesRef.current) { try { cs.removePriceLine(pl); } catch {} }
    priceLinesRef.current = [];

    if (!candles || candles.length === 0) {
      cs.setData([]);
      vs.setData([]);
      cs.setMarkers([]);
      return;
    }

    const seriesData = candles.map((c) => ({
      time: toSec(c.date),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    cs.setData(seriesData);

    const vwap = computeSessionVWAP(candles, yyyyMmDdET(new Date()));
    vs.setData(vwap);

    chart.timeScale().fitContent();

    // Entry/SL/TP lines & marker (only while actually open)
    const entryPrice = hasOpen ? (pos?.entryPrice ?? null) : null;
    const stopLoss = hasOpen ? (pos?.stopLoss ?? null) : null;
    const takeProfit = hasOpen ? (pos?.takeProfit ?? null) : null;
    const entryAt = hasOpen && pos?.entryAt ? toSec(pos.entryAt) : null;

    let markerTime = entryAt;
    if (entryAt && seriesData.length) {
      let best = seriesData[0].time as number;
      let bestDiff = Math.abs((seriesData[0].time as number) - entryAt);
      for (const pt of seriesData) {
        const diff = Math.abs((pt.time as number) - entryAt);
        if (diff < bestDiff) { best = pt.time as number; bestDiff = diff; }
      }
      markerTime = best;
    }

    const markers: any[] = [];

    if (entryPrice != null) {
      const pl = cs.createPriceLine({ price: entryPrice, title: "Entry", lineWidth: 1, color: "#9ca3af" });
      priceLinesRef.current.push(pl);
      if (markerTime) markers.push({ time: markerTime, position: "belowBar", color: "#9ca3af", shape: "arrowUp", text: "Entry" });
    }
    if (stopLoss != null) {
      const pl = cs.createPriceLine({ price: stopLoss, title: "Stop", lineWidth: 1, color: "#ef4444" });
      priceLinesRef.current.push(pl);
      if (markerTime) markers.push({ time: markerTime, position: "aboveBar", color: "#ef4444", shape: "arrowDown", text: "SL" });
    }
    if (takeProfit != null) {
      const pl = cs.createPriceLine({ price: takeProfit, title: "Target", lineWidth: 1, color: "#22c55e" });
      priceLinesRef.current.push(pl);
      if (markerTime) markers.push({ time: markerTime, position: "belowBar", color: "#22c55e", shape: "arrowUp", text: "TP" });
    }

    // Exit markers + average exit line (today only)
    if (Array.isArray(todayTrades) && todayTrades.length) {
      const sells = todayTrades.filter(t => t.side.toUpperCase() === "SELL");
      if (sells.length) {
        const totalSold = sells.reduce((s, r) => s + r.shares, 0);
        const wAvgExit = totalSold > 0 ? sells.reduce((s, r) => s + r.price * r.shares, 0) / totalSold : null;

        if (wAvgExit != null) {
          const pl = cs.createPriceLine({ price: wAvgExit, title: "Exit avg", lineWidth: 1, color: "#f59e0b" });
          priceLinesRef.current.push(pl);
        }

        for (const s of sells) {
          const t = toSec(s.at);
          // snap to nearest candle
          let mtime = t;
          let best = seriesData[0].time as number;
          let bestDiff = Math.abs((seriesData[0].time as number) - t);
          for (const pt of seriesData) {
            const diff = Math.abs((pt.time as number) - t);
            if (diff < bestDiff) { best = pt.time as number; bestDiff = diff; }
          }
          mtime = best;
          markers.push({ time: mtime, position: "aboveBar", color: "#f59e0b", shape: "arrowDown", text: `Exit ${s.shares}` });
        }
      }
    }

    cs.setMarkers(markers);
  }, [candles, pos?.entryPrice, pos?.stopLoss, pos?.takeProfit, pos?.entryAt, todayTrades, hasOpen]);

  // compute R:R in legend from hover price (assume long) – only meaningful while open
  const rr = useMemo(() => {
    if (!hasOpen || !pos?.entryPrice || !pos?.stopLoss) return null;
    const risk = Math.abs(pos.entryPrice - pos.stopLoss);
    if (risk <= 0) return null;
    const p = hover?.price ?? undefined;
    const tp = pos?.takeProfit ?? undefined;
    if (p == null) return null;
    const rToStop = (p - pos.stopLoss) / risk;
    const rToTP = tp != null ? (tp - p) / risk : undefined;
    return { rToStop, rToTP };
  }, [hover?.price, pos?.entryPrice, pos?.stopLoss, pos?.takeProfit, hasOpen]);

  const showChart = !!symbol; // show when we have a symbol (open OR sticky OR fallback)
  const headerLeft = showChart ? `${symbol} • 1-min • VWAP` : "1-min Chart";

  return (
    <div className="w-full">
      <div className="relative rounded-2xl border border-slate-700 bg-slate-900/70 shadow p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-slate-200 font-medium">{headerLeft}</div>
          {hasOpen && pos?.entryPrice != null ? (
            <div className="text-xs text-slate-400">
              Entry <span className="text-slate-200">${Number(pos.entryPrice).toFixed(2)}</span>
              {pos.stopLoss != null && (
                <>
                  <span className="mx-2">•</span>
                  SL <span className="text-red-400">${Number(pos.stopLoss).toFixed(2)}</span>
                </>
              )}
              {pos.takeProfit != null && (
                <>
                  <span className="mx-2">•</span>
                  TP <span className="text-green-400">${Number(pos.takeProfit).toFixed(2)}</span>
                </>
              )}
            </div>
          ) : stickyActive ? (
            <div className="text-xs text-slate-400 italic">Position closed — showing last chart until 4:00 PM ET.</div>
          ) : null}
        </div>

        {showChart ? (
          <>
            <div ref={containerRef} className="w-full" style={{ height }} />
            {/* Hover legend */}
            <div className="pointer-events-none absolute right-3 top-3 rounded-md bg-slate-800/80 px-3 py-2 text-[11px] leading-4 text-slate-200">
              {hover ? (
                <>
                  <div>O {hover.o?.toFixed(2)} H {hover.h?.toFixed(2)} L {hover.l?.toFixed(2)} C {hover.c?.toFixed(2)}</div>
                  <div>VWAP {hover.vwap != null ? hover.vwap.toFixed(2) : "—"}</div>
                  {rr ? (
                    <div className="text-slate-300">R→SL {rr.rToStop.toFixed(2)}x{rr.rToTP != null ? ` • R→TP ${rr.rToTP.toFixed(2)}x` : ""}</div>
                  ) : (
                    <div className="text-slate-500">R:R —</div>
                  )}
                </>
              ) : (
                <div className="text-slate-400">Hover for OHLC / VWAP</div>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-[260px] md:h-[300px]">
            <div className="text-slate-400 text-sm">
              No open positions yet. I’ll pop a live 1-min chart here when we enter.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
