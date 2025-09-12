"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/* ================= Types ================= */
type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };
type PositionWire = {
  open: boolean;
  ticker: string | null;
  shares: number | null;
  entryPrice: number | null;
  entryAt: string | null;
  stopLoss: number | null;
  takeProfit: number | null;
  error?: string;
};
type TradeWire = { side: "BUY" | "SELL" | string; ticker: string; price: number; shares: number; at: string };

/* ================= Time utils ================= */
const toSec = (ts: string | number | Date) =>
  Math.floor(
    (typeof ts === "string" ? new Date(ts).getTime() : ts instanceof Date ? ts.getTime() : ts) / 1000
  );

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
  const et = toET(nowUTC);
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
};

const isBeforeETClose = (nowUTC = new Date()) => {
  const et = toET(nowUTC);
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins <= 16 * 60;
};

/* ================= VWAP ================= */
function computeSessionVWAP(candles: Candle[], dayYMD: string) {
  let pv = 0,
    vol = 0;
  const out: { time: number; value: number }[] = [];
  for (const c of candles) {
    const d = toET(new Date(c.date));
    const mins = d.getHours() * 60 + d.getMinutes();
    if (!isSameETDay(d, dayYMD) || mins < 9 * 60 + 30) continue;

    const h = +c.high,
      l = +c.low,
      cl = +c.close,
      v = +c.volume;
    if (![h, l, cl, v].every(Number.isFinite)) continue;

    const typical = (h + l + cl) / 3;
    pv += typical * v;
    vol += v;
    if (vol > 0) out.push({ time: toSec(c.date), value: pv / vol });
  }
  return out;
}

/* ================= Data helpers ================= */
function useVisibility() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

async function fetchJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

const POS_EMPTY: PositionWire = {
  open: false,
  ticker: null,
  shares: null,
  entryPrice: null,
  entryAt: null,
  stopLoss: null,
  takeProfit: null,
};

function useOpenPosition(pollMsWhileOpen = 20000) {
  const visible = useVisibility();
  const [pos, setPos] = useState<PositionWire | null>(null);

  async function refresh() {
    try {
      setPos(await fetchJSON<PositionWire>("/api/positions/open"));
    } catch {
      setPos(POS_EMPTY);
      console.warn("[TradeChartPanel] /api/positions/open failed");
    }
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

function useTodayTrades(symbol: string | null, pollMsWhenActive = 30000, paused = false) {
  const visible = useVisibility();
  const [rows, setRows] = useState<TradeWire[] | null>(null);

  const toYMD = (d: Date) => {
    const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const y = et.getFullYear();
    const m = String(et.getMonth() + 1).padStart(2, "0");
    const day = String(et.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  async function load() {
    if (!symbol) return;
    const enc = encodeURIComponent(symbol);
    const urls = [
      `/api/trades/today?symbol=${enc}`,
      `/api/trades?symbol=${enc}&today=1`,
      `/api/trades?symbol=${enc}`,
      `/api/trades`,
    ];

    for (const url of urls) {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) continue;
        const j = await r.json();

        const raw: any[] = Array.isArray(j) ? j : Array.isArray(j?.trades) ? j.trades : [];
        if (!raw.length) continue;

        const todayKey = toYMD(new Date());
        const norm: TradeWire[] = raw
          .map((t: any) => ({
            side: String(t.side ?? t.type ?? "").toUpperCase(),
            ticker: String(t.ticker ?? t.symbol ?? "").toUpperCase(),
            price: Number(t.price ?? t.p ?? t.fill_price),
            shares: Number(t.shares ?? t.qty ?? t.quantity),
            at: String(t.at ?? t.time ?? t.createdAt ?? t.filledAt ?? t.executedAt ?? ""),
          }))
          .filter((t) => t.ticker === symbol.toUpperCase() && toYMD(new Date(t.at)) === todayKey);

        setRows(norm);
        return;
      } catch {
        /* try next */
      }
    }

    if (rows == null) setRows([]);
  }

  useEffect(() => {
    setRows(null);
    if (symbol) load();
  }, [symbol]);

  useEffect(() => {
    if (!symbol || !visible || !isMarketHoursET() || paused) return;
    const id = setInterval(load, pollMsWhenActive);
    return () => clearInterval(id);
  }, [symbol, visible, pollMsWhenActive, paused]);

  return rows;
}

function useCandles1m(
  symbol: string | null,
  isActiveFast: boolean,
  pollMsFast = 30000,
  pollMsSlow = 120000,
  limit = 240,
  paused = false
) {
  const visible = useVisibility();
  const [candles, setCandles] = useState<Candle[] | null>(null);

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
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) continue;
        const data = await r.json();

        const raw: any[] = Array.isArray(data)
          ? data
          : Array.isArray(data?.candles)
          ? data.candles
          : Array.isArray(data?.bars)
          ? data.bars
          : [];
        if (!raw.length) continue;

        const clean: Candle[] = raw
          .map((k: any) => ({
            date: String(k.date ?? k.time ?? k.t ?? ""),
            open: Number(k.open ?? k.o),
            high: Number(k.high ?? k.h),
            low: Number(k.low ?? k.l),
            close: Number(k.close ?? k.c),
            volume: Number(k.volume ?? k.v),
          }))
          .filter((k) => !!k.date && [k.open, k.high, k.low, k.close, k.volume].every(Number.isFinite));

        if (clean.length) return clean;
      } catch {
        /* try next */
      }
    }
    return [];
  }

  async function load(sym: string) {
    const out = await fetchCandles(sym);
    if (out.length) setCandles(out);
  }

  useEffect(() => {
    setCandles(null);
    if (symbol) load(symbol);
  }, [symbol]);

  useEffect(() => {
    if (!symbol || !visible || !isMarketHoursET() || paused) return;
    const ms = isActiveFast ? pollMsFast : pollMsSlow;
    const id = setInterval(() => load(symbol), ms);
    return () => clearInterval(id);
  }, [symbol, isActiveFast, visible, pollMsFast, pollMsSlow, paused]);

  return { candles };
}

/* ================= Alpaca day PnL ================= */
function useAlpacaDayPnL(pollMs = 15000) {
  const [pnl, setPnl] = useState<number | null>(null);

  useEffect(() => {
    let id: any;
    const run = async () => {
      try {
        const j = await fetchJSON<any>("/api/alpaca/account");
        const val =
          j?.ok && j?.account && (j.account.day_pnl != null ? Number(j.account.day_pnl) : null);
        if (val == null || Number.isNaN(val)) return;
        setPnl(val);
      } catch {
        /* ignore */
      }
    };
    run();
    id = setInterval(run, pollMs);
    return () => clearInterval(id);
  }, [pollMs]);

  return pnl;
}

/* ================= Panic Sell button ================= */
function PanicSellButton({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const PASSKEY = "9340";

  const confirm = async () => {
    if (key.trim() !== PASSKEY) {
      setMsg("❌ Incorrect passkey.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      let res = await fetch("/api/bot/panic-sell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key.trim() }),
      });
      let data: any = {};
      try {
        data = await res.json();
      } catch {}
      if (!res.ok || !(data?.ok ?? false)) {
        const reason =
          data?.error ||
          data?.message ||
          (typeof data === "string" ? data : "") ||
          `HTTP ${res.status}`;
        setMsg(`Panic sell failed: ${reason}`);
        return;
      }
      setMsg("✅ Sent market-close for all positions.");
      setTimeout(() => {
        setOpen(false);
        window.location.reload();
      }, 700);
    } catch {
      setMsg("Network error during panic sell.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={disabled}
        className={`rounded-lg px-3 py-1.5 text-xs font-semibold shadow
          ${disabled ? "bg-gray-400/70 text-white/80 cursor-not-allowed"
                     : "bg-red-600 text-white hover:bg-red-700 active:scale-[.99]"}`}
        title={disabled ? "No open position to close" : "Market close ALL positions"}
      >
        PANIC SELL
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget && !busy) setOpen(false); }}
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <div className="text-lg font-semibold text-slate-800">Panic Sell — Close ALL Positions</div>
            <p className="mt-1 text-sm text-slate-600">Sends market orders to flatten every open position.</p>

            <label className="block mt-4 text-sm text-slate-700">Passkey</label>
            <input
              type="password"
              autoFocus
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-red-500"
              placeholder="Enter passkey (4 digits)"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && key) confirm();
                if (e.key === "Escape" && !busy) setOpen(false);
              }}
            />

            {msg && <div className="mt-3 text-sm">{msg}</div>}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                disabled={busy}
                onClick={() => setOpen(false)}
                className="rounded-xl px-3 py-1.5 text-sm font-medium border border-slate-300 text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                disabled={busy || key.length === 0}
                onClick={confirm}
                className="rounded-xl px-3 py-1.5 text-sm font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-60"
              >
                {busy ? "Sending…" : "Confirm Panic Sell"}
              </button>
            </div>

            <div className="mt-3 text-xs text-slate-500">
              Hint: passkey is <span className="font-semibold">9340</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ================= lightweight-charts v4 ONLY (CDN) ================= */
declare global {
  interface Window {
    LightweightCharts?: any;
  }
}
async function ensureLWv4(): Promise<any | null> {
  if (typeof window === "undefined") return null;
  if (window.LightweightCharts?.createChart) return window.LightweightCharts;
  await new Promise<void>((res, rej) => {
    const s = document.createElement("script");
    s.src =
      "https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js";
    s.async = true;
    s.onload = () => res();
    s.onerror = () => rej();
    document.head.appendChild(s);
  }).catch(() => {});
  return window.LightweightCharts?.createChart ? window.LightweightCharts : null;
}

/* ================= Reusable chart view (no fetching) ================= */
function ChartView({
  height,
  symbol,
  candles,
  todayTrades,
  pos,
  dayPnl,
  showPopOut,
  onPopOut,
  showClose,
  onClose,
}: {
  height: number;
  symbol: string | null;
  candles: Candle[] | null;
  todayTrades: TradeWire[] | null;
  pos: PositionWire | null;
  dayPnl: number | null;
  showPopOut?: boolean;
  onPopOut?: () => void;
  showClose?: boolean;
  onClose?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const createdRef = useRef(false);
  const chartRef = useRef<any>(null);
  const candleSeriesRef = useRef<any>(null);
  const vwapSeriesRef = useRef<any>(null);
  const priceLinesRef = useRef<any[]>([]);
  const [hover, setHover] = useState<{ price?: number; o?: number; h?: number; l?: number; c?: number; vwap?: number } | null>(null);

  const headerLeft = symbol ? `${symbol} • 1-min • VWAP` : "1-min Chart";
  const dayYMD = yyyyMmDdET(new Date());

  /* create chart once */
  useEffect(() => {
    let cleanup = () => {};
    (async () => {
      if (!containerRef.current || createdRef.current) return;
      createdRef.current = true;

      containerRef.current.innerHTML = "";
      containerRef.current.style.height = `${height}px`;

      const L = await ensureLWv4();
      if (!L?.createChart) {
        createdRef.current = false;
        console.error("[ChartView] LW v4 not loaded");
        return;
      }

      const chart = L.createChart(containerRef.current, {
        height,
        layout: { textColor: "#e5e7eb", background: { type: L.ColorType.Solid, color: "#0b1220" } },
        grid: { vertLines: { visible: false }, horzLines: { visible: true, color: "#1f2a44" } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
        crosshair: { mode: L.CrosshairMode.Normal },
        watermark: { visible: false } as any,
      });

      const candleSeries = chart.addCandlestickSeries({});
      candleSeries.applyOptions({
        upColor: "#22c55e",
        downColor: "#ef4444",
        wickUpColor: "#22c55e",
        wickDownColor: "#ef4444",
        borderVisible: false,
      });

      const vwapSeries = chart.addLineSeries({});
      vwapSeries.applyOptions({ lineWidth: 2 });

      const onMove = (p: any) => {
        if (!p?.time) {
          setHover(null);
          return;
        }
        const sd = p.seriesData as Map<any, any>;
        const c = sd?.get(candleSeries);
        const v = sd?.get(vwapSeries);
        if (!c) {
          setHover(null);
          return;
        }
        setHover({
          o: c.open,
          h: c.high,
          l: c.low,
          c: c.close,
          price: c.close,
          vwap: typeof v?.value === "number" ? v.value : undefined,
        });
      };
      chart.subscribeCrosshairMove(onMove);

      chartRef.current = chart;
      candleSeriesRef.current = candleSeries;
      vwapSeriesRef.current = vwapSeries;

      const applyWidth = () => {
        if (!containerRef.current) return;
        chart.applyOptions({ width: containerRef.current.clientWidth });
      };
      applyWidth();

      const ro = new ResizeObserver(applyWidth);
      ro.observe(containerRef.current);
      const onWinResize = () => applyWidth();
      window.addEventListener("resize", onWinResize);

      cleanup = () => {
        window.removeEventListener("resize", onWinResize);
        ro.disconnect();
        chart.unsubscribeCrosshairMove(onMove);
        chart.remove?.();
        createdRef.current = false;
      };
    })();
    return () => cleanup();
  }, [height]);

  /* update data/lines/markers */
  useEffect(() => {
    const cs = candleSeriesRef.current;
    const vs = vwapSeriesRef.current;
    const chart = chartRef.current;
    if (!cs || !chart) return;

    for (const pl of priceLinesRef.current) {
      try {
        cs.removePriceLine(pl);
      } catch {}
    }
    priceLinesRef.current = [];

    if (!candles?.length) {
      cs.setData([]);
      try {
        vs?.setData?.([]);
      } catch {}
      cs.setMarkers([]);
      return;
    }

    const seriesData = candles.map((c) => ({
      time: toSec(c.date),
      open: +c.open,
      high: +c.high,
      low: +c.low,
      close: +c.close,
    }));
    cs.setData(seriesData);

    if (vs) {
      const vwap = computeSessionVWAP(candles, dayYMD);
      vs.setData(Array.isArray(vwap) ? vwap : []);
    }

    chart.timeScale().fitContent();

    const isOpen = !!pos?.open && !!pos?.ticker;
    const entryPrice = isOpen ? pos?.entryPrice ?? null : null;
    const stopLoss = isOpen ? pos?.stopLoss ?? null : null;
    const takeProfit = isOpen ? pos?.takeProfit ?? null : null;
    const entryAt = isOpen && pos?.entryAt ? toSec(pos.entryAt) : null;

    let markerTime = entryAt;
    if (entryAt && seriesData.length) {
      let best = seriesData[0].time as number;
      let bestDiff = Math.abs(best - entryAt);
      for (const pt of seriesData) {
        const diff = Math.abs((pt.time as number) - entryAt);
        if (diff < bestDiff) {
          best = pt.time as number;
          bestDiff = diff;
        }
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

    if (Array.isArray(todayTrades) && todayTrades.length) {
      const sells = todayTrades.filter((t) => String(t.side).toUpperCase() === "SELL");
      if (sells.length) {
        const totalSold = sells.reduce((s, r) => s + (+r.shares || 0), 0);
        const wAvgExit =
          totalSold > 0 ? sells.reduce((s, r) => s + (+r.price || 0) * (+r.shares || 0), 0) / totalSold : null;

        if (wAvgExit != null && Number.isFinite(wAvgExit)) {
          const pl = cs.createPriceLine({ price: wAvgExit, title: "Exit avg", lineWidth: 1, color: "#f59e0b" });
          priceLinesRef.current.push(pl);
        }

        for (const s of sells) {
          const t = toSec(s.at);
          let best = seriesData[0].time as number;
          let bestDiff = Math.abs(best - t);
          for (const pt of seriesData) {
            const diff = Math.abs((pt.time as number) - t);
            if (diff < bestDiff) {
              best = pt.time as number;
              bestDiff = diff;
            }
          }
          markers.push({ time: best, position: "aboveBar", color: "#f59e0b", shape: "arrowDown", text: `Exit ${s.shares}` });
        }
      }
    }

    cs.setMarkers(markers);
  }, [candles, todayTrades, pos?.entryPrice, pos?.stopLoss, pos?.takeProfit, pos?.entryAt, pos?.open, pos?.ticker]);

  const rr = useMemo(() => {
    if (!(pos?.open && pos?.entryPrice && pos?.stopLoss)) return null;
    const risk = Math.abs(pos.entryPrice - pos.stopLoss);
    if (risk <= 0) return null;
    const p = hover?.price;
    if (p == null) return null;
    const tp = pos.takeProfit ?? undefined;
    return { rToStop: (p - pos.stopLoss) / risk, rToTP: tp != null ? (tp - p) / risk : undefined };
  }, [hover?.price, pos?.entryPrice, pos?.stopLoss, pos?.takeProfit, pos?.open]);

  const panicDisabled = !(pos?.open && (pos.shares ?? 0) !== 0);

  return (
    <div className="relative rounded-2xl border border-slate-700 bg-slate-900/70 shadow p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-slate-200 font-medium">{headerLeft}</div>
        {pos?.open && pos?.entryPrice != null ? (
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
        ) : null}
      </div>

      {/* Chart canvas */}
      <div ref={containerRef} className="w-full min-h-0" style={{ height, lineHeight: 0 }} />

      {/* Overlays (z-index high to stay in front of the chart) */}
      <div className="pointer-events-none absolute inset-0 z-[60]">
        {/* OHLC/VWAP (top-right) */}
        <div className="absolute right-3 top-3 rounded-md bg-slate-800/80 px-3 py-2 text-[11px] leading-4 text-slate-200">
          {hover ? (
            <>
              <div>
                O {hover.o?.toFixed(2)} H {hover.h?.toFixed(2)} L {hover.l?.toFixed(2)} C {hover.c?.toFixed(2)}
              </div>
              <div>VWAP {hover.vwap != null ? hover.vwap.toFixed(2) : "—"}</div>
              {rr ? (
                <div className="text-slate-300">
                  R→SL {rr.rToStop.toFixed(2)}x{rr.rToTP != null ? ` • R→TP ${rr.rToTP.toFixed(2)}x` : ""}
                </div>
              ) : (
                <div className="text-slate-500">R:R —</div>
              )}
            </>
          ) : (
            <div className="text-slate-400">Hover for OHLC / VWAP</div>
          )}
        </div>

        {/* PnL + Panic Sell (bottom-right) */}
        <div className="absolute bottom-2 right-2 pointer-events-auto flex items-center gap-2">
          <div
            className={[
              "px-3 py-1.5 rounded-full text-xs font-semibold shadow-lg",
              dayPnl == null
                ? "bg-slate-600 text-white"
                : dayPnl >= 0
                ? "bg-emerald-600 text-white"
                : "bg-rose-600 text-white",
            ].join(" ")}
            title="Today's PnL (Alpaca)"
          >
            {dayPnl == null ? "—" : `${dayPnl >= 0 ? "+" : "-"}$${Math.abs(dayPnl).toFixed(2)}`}
          </div>
          <PanicSellButton disabled={panicDisabled} />
        </div>

        {/* Pop Out (bottom-left) / Close (top-right) */}
        {showPopOut && (
          <div className="absolute bottom-2 left-2 pointer-events-auto">
            <button
              onClick={onPopOut}
              className="rounded-md bg-slate-800/90 text-white text-xs px-3 py-1.5 shadow hover:bg-slate-700"
              title="Open big chart"
            >
              Pop Out
            </button>
          </div>
        )}
        {showClose && (
          <div className="absolute top-2 right-2 pointer-events-auto">
            <button
              onClick={onClose}
              className="rounded-md bg-slate-900 text-white text-xs px-3 py-1.5 shadow hover:bg-slate-800"
              title="Close"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ================= Component (fetching + modal) ================= */
export default function TradeChartPanel({
  height = 360,
  symbolWhenFlat,
}: {
  height?: number;
  symbolWhenFlat?: string | null | undefined;
}) {
  const pos = useOpenPosition(20000);

  // 4pm ET gate for fallback
  const [beforeCloseFlag, setBeforeCloseFlag] = useState(isBeforeETClose());
  useEffect(() => {
    const id = setInterval(() => setBeforeETClose(isBeforeETClose()), 60_000);
    function setBeforeETClose(v: boolean) {
      setBeforeCloseFlag(v);
    }
    return () => clearInterval(id);
  }, []);

  // sticky symbol for the day
  const dayYMD = useMemo(() => yyyyMmDdET(new Date()), []);
  const [stickySymbol, setStickySymbol] = useState<string | null>(null);
  const [stickyDay, setStickyDay] = useState<string | null>(null);
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

  useEffect(() => {
    const id = setInterval(() => {
      if (!isBeforeETClose() && stickySymbol) {
        setStickySymbol(null);
        setStickyDay(null);
        try {
          sessionStorage.removeItem("chartSticky");
        } catch {}
      }
    }, 60_000);
    return () => clearInterval(id);
  }, [stickySymbol]);

  const stickyActive = !!stickySymbol && stickyDay === dayYMD && beforeCloseFlag;
  const symbol: string | null =
    hasOpen
      ? (pos!.ticker as string)
      : stickyActive
      ? stickySymbol
      : beforeCloseFlag && symbolWhenFlat
      ? String(symbolWhenFlat)
      : null;

  // Big view (modal). While open, pause polling in hooks below.
  const [bigOpen, setBigOpen] = useState(false);
  const paused = bigOpen;

  const { candles } = useCandles1m(symbol, hasOpen || stickyActive, 30000, 120000, 240, paused);
  const todayTrades = useTodayTrades(symbol, 30000, paused);

  // Day PnL (shared by both views, no duplicate calls)
  const dayPnl = useAlpacaDayPnL(15000);

  return (
    <>
      {/* Inline chart with Pop Out button (bottom-left) */}
      {symbol ? (
        <ChartView
          height={height}
          symbol={symbol}
          candles={candles}
          todayTrades={todayTrades}
          pos={pos}
          dayPnl={dayPnl}
          showPopOut
          onPopOut={() => setBigOpen(true)}
        />
      ) : (
        <div className="relative rounded-2xl border border-slate-700 bg-slate-900/70 shadow p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-slate-200 font-medium">1-min Chart</div>
          </div>
          <div className="flex items-center justify-center h-[260px] md:h-[300px] text-slate-400 text-sm">
            No open positions yet. I’ll pop a live 1-min chart here when we enter.
          </div>
        </div>
      )}

      {/* Full-screen big chart (no extra polling; reuses data) */}
      {bigOpen && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setBigOpen(false);
          }}
        >
          <div className="w-full max-w-[1400px]">
            <ChartView
              height={820}
              symbol={symbol}
              candles={candles}
              todayTrades={todayTrades}
              pos={pos}
              dayPnl={dayPnl}
              showClose
              onClose={() => setBigOpen(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}
