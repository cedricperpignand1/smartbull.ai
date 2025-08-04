"use client";

import { useEffect, useRef, useState } from "react";

type Mode = "auto" | "fmp" | "alpaca";

interface Stock {
  ticker: string;
  price: number;
  changesPercentage: number;
  marketCap: number | null;
  sharesOutstanding: number | null;
  volume: number | null;
  // Optional fields if your API includes them (sent through to /api/recommendation as-is)
  employees?: number | null;
  netProfitMarginTTM?: number | null;
  profitMargin?: number | null;
  netProfitMargin?: number | null;
}

export default function TopGainers() {
  const [mode, setMode] = useState<Mode>("auto");
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sourceUsed, setSourceUsed] = useState<string>("");
  const [updatedAt, setUpdatedAt] = useState<string>("");
  const [marketOpen, setMarketOpen] = useState<boolean | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // --- AI Recommendation UI state ---
  const [aiPick, setAiPick] = useState<string>("");
  const [aiLoading, setAiLoading] = useState(false);

  const fetchData = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/stocks?source=${mode}`, { cache: "no-store" });
      const data = await res.json();

      if (data.errorMessage) {
        setErrorMessage(data.errorMessage);
        setStocks([]);
        setSourceUsed("");
      } else {
        setStocks(data.stocks || []);
        setSourceUsed(data.sourceUsed || data.source || "");
        setUpdatedAt(data.updatedAt || "");
        setMarketOpen(typeof data.marketOpen === "boolean" ? data.marketOpen : null);
        setErrorMessage(null);
      }
    } catch (err) {
      console.error("Error fetching stocks:", err);
      setErrorMessage("Unable to fetch data.");
    } finally {
      setLoading(false);
    }
  };

  // Initial fetch + 5s auto-refresh
  useEffect(() => {
    fetchData();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(fetchData, 5000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [mode]);

  // One-button toggle: if Auto -> FMP; then FMP <-> Alpaca
  const handleSwitch = () => {
    setMode((prev) => (prev === "auto" ? "fmp" : prev === "fmp" ? "alpaca" : "fmp"));
  };

  // ---- #2: Send current stocks to /api/recommendation and show reply ----
  const getRecommendation = async () => {
    try {
      setAiLoading(true);
      setAiPick("");
      const res = await fetch("/api/recommendation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Send exactly what the API expects
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
    <div className="flex flex-col p-4 flex-1 overflow-auto">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <h2 className="font-bold text-lg">Top Gainers</h2>

          {sourceUsed && (
            <span
              className={`px-2 py-1 rounded text-xs font-semibold ${
                sourceUsed === "FMP"
                  ? "bg-green-100 text-green-700"
                  : "bg-purple-100 text-purple-700"
              }`}
            >
              {sourceUsed === "FMP" ? "Market Hours (FMP)" : "Premarket/After Hours (Alpaca)"}
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
          <table className="min-w-full text-xs sm:text-sm">
            <thead>
              <tr className="bg-green-600 text-white">
                <th className="p-2">Symbol</th>
                <th className="p-2">Price</th>
                <th className="p-2">Change %</th>
                <th className="p-2">Market Cap</th>
                <th className="p-2">Float</th>
                <th className="p-2">Volume</th>
              </tr>
            </thead>
            <tbody>
              {stocks.map((s, i) => (
                <tr key={i} className="hover:bg-gray-100">
                  <td className="border p-2">{s.ticker}</td>
                  <td className="border p-2">
                    {s.price !== null && s.price !== undefined ? `$${s.price}` : "-"}
                  </td>
                  <td
                    className="border p-2"
                    style={{ color: s.changesPercentage >= 0 ? "green" : "red" }}
                  >
                    {s.changesPercentage?.toFixed?.(2) ?? "-"}%
                  </td>
                  <td className="border p-2">{s.marketCap?.toLocaleString() ?? "-"}</td>
                  <td className="border p-2">
                    {s.sharesOutstanding?.toLocaleString() ?? "-"}
                  </td>
                  <td className="border p-2">{s.volume?.toLocaleString() ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* ---- AI Recommendation UI ---- */}
          <div className="mt-3 flex items-start gap-2">
            <button
              onClick={getRecommendation}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm"
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
          {/* ---- /AI Recommendation UI ---- */}
        </div>
      )}
    </div>
  );
}
