"use client";

import { useEffect, useState } from "react";

interface Stock {
  ticker: string;
  price: number;
  changesPercentage: number;
  marketCap: number | null;
  sharesOutstanding: number | null;
  volume: number | null;
}

function isMarketOpenNow(): boolean {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const estOffset = -5; // EST offset
  const est = new Date(utc + 3600000 * estOffset);

  const day = est.getUTCDay();
  const hour = est.getUTCHours();
  const minute = est.getUTCMinutes();

  const isWeekday = day >= 1 && day <= 5;
  const after930 = hour > 9 || (hour === 9 && minute >= 30);
  const before4 = hour < 16;
  return isWeekday && after930 && before4;
}

export default function TopGainers() {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<string>("");

  const fetchData = async (overrideSource?: string) => {
    try {
      let source = overrideSource;
      if (!source) {
        source = isMarketOpenNow() ? "fmp" : "alpaca";
      }

      const res = await fetch(`/api/stocks?source=${source}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (data.errorMessage) {
        setErrorMessage(data.errorMessage);
      } else {
        setStocks(data.stocks || data);
        setDataSource(data.source || "");
      }
      setLoading(false);
    } catch (err) {
      console.error("Error fetching stocks:", err);
      setErrorMessage("Unable to fetch data.");
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleSwitch = () => {
    const newSource = dataSource === "FMP" ? "alpaca" : "fmp";
    fetchData(newSource);
  };

  return (
    <div className="flex flex-col p-4 flex-1 overflow-auto">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <h2 className="font-bold text-lg">Top Gainers</h2>
          {dataSource && (
            <span
              className={`px-2 py-1 rounded text-xs font-semibold ${
                dataSource === "FMP"
                  ? "bg-green-100 text-green-700"
                  : "bg-purple-100 text-purple-700"
              }`}
            >
              {dataSource === "FMP"
                ? "Market Open (FMP)"
                : "Premarket/After Hours (Alpaca)"}
            </span>
          )}
        </div>
        <button
          onClick={handleSwitch}
          className="px-3 py-1 bg-gray-800 hover:bg-gray-700 rounded text-sm text-white"
        >
          Switch
        </button>
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
              {stocks.map((stock, i) => (
                <tr key={i} className="hover:bg-gray-100 cursor-pointer">
                  <td className="border p-2">{stock.ticker}</td>
                  <td className="border p-2">${stock.price}</td>
                  <td
                    className="border p-2"
                    style={{
                      color: stock.changesPercentage >= 0 ? "green" : "red",
                    }}
                  >
                    {stock.changesPercentage.toFixed(2)}%
                  </td>
                  <td className="border p-2">
                    {stock.marketCap?.toLocaleString() || "-"}
                  </td>
                  <td className="border p-2">
                    {stock.sharesOutstanding?.toLocaleString() || "-"}
                  </td>
                  <td className="border p-2">
                    {stock.volume?.toLocaleString() || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
