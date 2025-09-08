"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  symbol: string;                         // e.g. "SNTG"
  height?: number;                        // default 680 for modal
  theme?: "light" | "dark";
  interval?: "1" | "3" | "5" | "15" | "30" | "60" | "120" | "240" | "D";
  timezone?: string;
};

declare global {
  interface Window {
    TradingView?: any;
  }
}

let tvLoaderPromise: Promise<void> | null = null;
function loadTVScriptOnce() {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.TradingView) return Promise.resolve();
  if (tvLoaderPromise) return tvLoaderPromise;

  tvLoaderPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://s3.tradingview.com/tv.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = (e) => reject(e);
    document.head.appendChild(s);        // important: append to <head>
  });
  return tvLoaderPromise;
}

// Basic US prefix — adjust if you route some tickers to NYSE/AMEX
function withExchangePrefix(sym: string) {
  const u = sym.trim().toUpperCase();
  return u.includes(":") ? u : `NASDAQ:${u}`;
}

export default function TradingViewChart({
  symbol,
  height = 680,
  theme = "dark",
  interval = "1",
  timezone = "America/New_York",
}: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const containerId = useMemo(() => `tv_${Math.random().toString(36).slice(2)}`, []);
  const finalSymbol = useMemo(() => withExchangePrefix(symbol), [symbol]);

  // Ensure the container has size (modal mounts -> 0x0 first)
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const check = () => {
      const r = el.getBoundingClientRect();
      setReady(r.width > 100 && r.height > 100);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build / rebuild widget
  useEffect(() => {
    let disposed = false;

    async function build() {
      if (!ready) return;
      await loadTVScriptOnce();
      if (disposed) return;

      try { widgetRef.current?.remove?.(); } catch {}
      widgetRef.current = null;

      const w = new window.TradingView.widget({
        container_id: containerId,
        autosize: true,
        symbol: finalSymbol,                 // e.g. "NASDAQ:SNTG"
        interval,                            // "1" = 1-minute
        timezone,
        theme,
        style: "1",
        locale: "en",
        studies: ["VWAP@tv-basicstudies"],
        withdateranges: true,
        hide_top_toolbar: false,
        hidesidetoolbar: false,
        allow_symbol_change: false,
        calendar: false,
      });

      widgetRef.current = w;

      // nudge layout after mount
      setTimeout(() => { if (!disposed) window.dispatchEvent(new Event("resize")); }, 50);
    }

    build();

    return () => {
      disposed = true;
      try { widgetRef.current?.remove?.(); } catch {}
      widgetRef.current = null;
    };
  }, [ready, finalSymbol, interval, theme, timezone, containerId]);

  return (
    <div ref={wrapperRef} style={{ width: "100%", height }} className="relative">
      <div id={containerId} style={{ width: "100%", height: "100%" }} />
      {!ready && (
        <div className="absolute inset-0 grid place-items-center text-slate-400 text-sm">
          Preparing chart…
        </div>
      )}
    </div>
  );
}
