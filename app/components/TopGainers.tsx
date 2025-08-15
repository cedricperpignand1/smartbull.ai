"use client";

import { useEffect, useRef, useState } from "react";

type Mode = "auto" | "fmp" | "alpaca";

interface Stock {
  ticker: string;
  price: number;
  changesPercentage: number;
  marketCap: number | null;
  sharesOutstanding: number | null; // Float
  volume: number | null;
  avgVolume?: number | null;
  employees?: number | null;
  netProfitMarginTTM?: number | null;
  profitMargin?: number | null;
  netProfitMargin?: number | null;
}

/* ===========================
   Small reusable smart-polling hook
   - Pauses when tab hidden or panel off-screen
   - Avoids overlapping fetches
=========================== */
function useSmartPolling(
  fn: () => Promise<void> | void,
  opts: { intervalMs?: number; container?: React.RefObject<HTMLElement | null> } = {}
) {
  const { intervalMs = 5000, container } = opts;
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const inFlight = useRef(false);
  const isContainerVisible = useRef(true); // assume visible unless we observe it

  const start = () => {
    if (timerRef.current) return;
    timerRef.current = setInterval(async () => {
      if (document.hidden) return;
      if (!isContainerVisible.current) return;
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        await fn();
      } finally {
        inFlight.current = false;
      }
    }, intervalMs);
  };

  const stop = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const runNowIfVisible = async () => {
    if (document.hidden) return;
    if (!isContainerVisible.current) return;
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await fn();
    } finally {
      inFlight.current = false;
    }
  };

  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        stop();
      } else {
        start();
        void runNowIfVisible();
      }
    };
    document.addEventListener("visibilitychange", onVis);

    let observer: IntersectionObserver | null = null;
    if (container?.current) {
      observer = new IntersectionObserver(
        ([entry]) => {
          isContainerVisible.current = !!entry?.isIntersecting;
          if (!isContainerVisible.current) {
            stop();
          } else {
            start();
            void runNowIfVisible();
          }
        },
        { threshold: 0.1 }
      );
      observer.observe(container.current);
    }

    // kick it off
    start();
    void runNowIfVisible();

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (observer) observer.disconnect();
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, container]);
}

/* ===========================
   Utilities
=========================== */
function fmt(n?: number | null) {
  return typeof n === "number" ? n.toLocaleString() : "-";
}

/* ===========================
   Component
=========================== */
export default function TopGainers() {
  const [mode, setMode] = useState<Mode>("auto");
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sourceUsed, setSourceUsed] = useState<string>("");
  const [updatedAt, setUpdatedAt] = useState<string>("");
  const [marketOpen, setMarketOpen] = useState<boolean | null>(null);

  const [aiPick, setAiPick] = useState<string>("");
  const [aiLoading, setAiLoading] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Centralized fetch that reads from the cached snapshot route
  const fetchData = async () => {
    try {
      // cancel a slow previous request
      if (abortRef.current) abortRef.current.abort();
      abortRef.current = new AbortController();

      setLoading((prev) => (stocks.length ? prev : true)); // don't flash spinner if we already have data
      // Using the cached snapshot endpoint for huge API savings
      const res = await fetch(`/api/stocks/snapshot`, {
        cache: "no-store",
        signal: abortRef.current.signal,
      });
      const data = await res.json();

      if (data.errorMessage) {
        setErrorMessage(data.errorMessage);
        setStocks([]);
        setSourceUsed("");
      } else {
        setStocks(data.stocks || []);
        setSourceUsed(data.sourceUsed || data.source || "Auto");
        setUpdatedAt(data.updatedAt || "");
        setMarketOpen(typeof data.marketOpen === "boolean" ? data.marketOpen : null);
        setErrorMessage(null);
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        console.error("Error fetching stocks:", err);
        setErrorMessage("Unable to fetch data.");
      }
    } finally {
      setLoading(false);
    }
  };

  // Smart polling: pauses when tab hidden or this panel is off-screen
  useSmartPolling(fetchData, { intervalMs: 5000, container: containerRef });

  // If you still want to keep the "mode" selector visible,
  // do a one-off fetch when it changes (snapshot itself uses auto on the server).
  useEffect(() => {
    void fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const handleSwitch = () => {
    setMode((prev) => (prev === "auto" ? "fmp" : prev === "fmp" ? "alpaca" : "fmp"));
  };

  const getRecommendation = async () => {
    try {
      setAiLoading(true);
      setAiPick("");
      const res = await fetch("/api/recommendation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stocks }),
      });
      const data = await res.json();
      setAiPick(data.recommendation || "No recommendation.");
    } catch (e) {
      console.error(e);
      setAiPick("Error getting recommendation.");
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div ref={containerRef} className="flex flex-col p-4 flex-1 overflow-auto">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <h2 className="font-bold text-lg">Top Gainers</h2>

          {sourceUsed && (
            <span
              className={`px-2 py-1 rounded text-xs font-semibold ${
                sourceUsed === "FMP"
                  ? "bg-green-100 text-green-700"
                  : sourceUsed === "Alpaca"
                  ? "bg-purple-100 text-purple-700"
                  : "bg-gray-100 text-gray-700"
              }`}
              title="Data source currently in use"
            >
              {sourceUsed === "FMP"
                ? "Market Hours (FMP)"
                : sourceUsed === "Alpaca"
                ? "Premarket/After Hours (Alpaca)"
                : sourceUsed}
            </span>
          )}

          {marketOpen !== null && (
            <span className="px-2 py-1 rounded text-xs bg-gray-100 text-gray-700">
              Market Open: {marketOpen ? "Yes" : "No"}
            </span>
          )}

          {updatedAt && (
            <span className="text-xs text-gray-500">
              Updated: {new Date(updatedAt).toLocaleTimeString()}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as Mode)}
            className="px-2 py-1 border rounded text-sm"
            title="Auto uses FMP during market hours, Alpaca otherwise"
          >
            <option value="auto">Auto</option>
            <option value="fmp">FMP</option>
            <option value="alpaca">Alpaca</option>
          </select>

          <button
            onClick={handleSwitch}
            className="px-3 py-1 bg-gray-800 hover:bg-gray-700 rounded text-sm text-white"
            title="Cycle between Auto → FMP → Alpaca"
          >
            Switch
          </button>
        </div>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : errorMessage ? (
        <p className="text-red-600">{errorMessage}</p>
      ) : (
        <div className="flex-1 overflow-auto">
          {/* Rounded modern table */}
          <table className="min-w-full text-xs sm:text-sm border-separate border-spacing-y-2 border-spacing-x-0">
            <thead>
              <tr className="bg-green-600 text-white">
                <th className="p-2 text-left first:rounded-l-xl last:rounded-r-xl">Symbol</th>
                <th className="p-2 text-left">Price</th>
                <th className="p-2 text-left">Change %</th>
                <th className="p-2 text-left">Market Cap</th>
                <th className="p-2 text-left">Float</th>
                <th className="p-2 text-left">Volume</th>
                <th className="p-2 text-left last:rounded-r-xl">Avg Vol</th>
              </tr>
            </thead>

            <tbody>
              {stocks.map((s, i) => (
                <tr
                  key={i}
                  className="bg-white ring-1 ring-gray-200 shadow-sm hover:shadow-md transition-shadow"
                >
                  <td className="px-3 py-2 first:rounded-l-xl font-semibold text-gray-900">
                    {s.ticker}
                  </td>
                  <td className="px-3 py-2 text-gray-700">
                    {s.price !== null && s.price !== undefined ? `$${Number(s.price).toFixed(2)}` : "-"}
                  </td>
                  <td
                    className={`px-3 py-2 font-medium ${
                      s.changesPercentage >= 0 ? "text-green-600" : "text-red-600"
                    }`}
                  >
                    {s.changesPercentage?.toFixed?.(2) ?? "-"}%
                  </td>
                  <td className="px-3 py-2 text-gray-700">{fmt(s.marketCap)}</td>
                  <td className="px-3 py-2 text-gray-700">{fmt(s.sharesOutstanding)}</td>
                  <td className="px-3 py-2 text-gray-700">{fmt(s.volume)}</td>
                  <td className="px-3 py-2 text-gray-700 last:rounded-r-xl">{fmt(s.avgVolume)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-3 flex items-start gap-2">
            <button
              onClick={getRecommendation}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={!stocks.length || aiLoading}
            >
              {aiLoading ? "Analyzing..." : "Get AI Pick"}
            </button>

            {aiPick && (
              <div className="text-sm bg-gray-50 border rounded p-2 whitespace-pre-wrap flex-1">
                <strong>AI Recommendation:</strong>
                <div className="mt-1">{aiPick}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
