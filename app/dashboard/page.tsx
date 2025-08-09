"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Rnd } from "react-rnd";
import Navbar from "../components/Navbar";
import { Button } from "../components/ui/button";

interface Stock {
  ticker: string;
  price: number;
  changesPercentage: number;
  marketCap: number | null;
  sharesOutstanding: number | null;
  volume: number | null;
  employees?: number | null;
}

export default function Home() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <div className="flex items-center justify-center h-screen">Loading...</div>;
  }
  if (!session) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-lg font-bold">You need to log in to access this page.</p>
      </div>
    );
  }

  // ---- Stocks & AI analysis (your existing state) ----
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [dataSource, setDataSource] = useState<string>(""); // "FMP" | "Alpaca"
  const [recommendation, setRecommendation] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const [selectedStock, setSelectedStock] = useState<string | null>(null);
  const [chartVisible, setChartVisible] = useState(false);

  const [agentResult, setAgentResult] = useState<string | null>(null);
  const [agentBuyPrice, setAgentBuyPrice] = useState<string | null>(null);
  const [agentSellPrice, setAgentSellPrice] = useState<string | null>(null);

  // ---- NEW: Bot polling state ----
  const [botData, setBotData] = useState<any>(null);

  // Table headers rendered from array to avoid whitespace text nodes in <tr>
  const HEADERS = ["Symbol", "Price", "Change %", "Market Cap", "Float", "Volume", "Employees"];

  // Load top gainers list
  useEffect(() => {
    fetch("/api/stocks", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (data.errorMessage) {
          setErrorMessage(data.errorMessage);
        } else {
          setStocks(data.stocks || data);
          setDataSource(data.sourceUsed || data.source || "");
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error("Error fetching stocks:", err);
        setErrorMessage("Unable to fetch data. You may have run out of API calls on FMP.");
        setLoading(false);
      });
  }, []);

  // ---- NEW: Poll the bot tick endpoint every 5s ----
  useEffect(() => {
    let id: any;
    const run = async () => {
      try {
        const r = await fetch("/api/bot/tick", { cache: "no-store" });
        const j = await r.json();
        setBotData(j);
      } catch (e) {
        console.error("bot tick error", e);
      }
    };
    run();
    id = setInterval(run, 5000);
    return () => clearInterval(id);
  }, []);

  const askAIRecommendation = async () => {
    try {
      setAnalyzing(true);
      setRecommendation(null);

      const res = await fetch("/api/recommendation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stocks: stocks.slice(0, 15) }),
      });

      const data = await res.json();
      if (data.errorMessage) {
        setRecommendation(`Error: ${data.errorMessage}`);
      } else {
        setRecommendation(data.recommendation || "No recommendation.");
      }
    } catch (error) {
      console.error("Error fetching AI recommendation:", error);
      setRecommendation("Failed to analyze stocks. Check server logs.");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleStockClick = (ticker: string) => {
    setSelectedStock(ticker);
    setChartVisible(true);
    setAgentResult(null);
    setAgentBuyPrice(null);
    setAgentSellPrice(null);
  };

  const handleAgent = async () => {
    try {
      const res = await fetch("/api/chart-analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: selectedStock }),
      });
      if (!res.ok) throw new Error("Failed to analyze chart");
      const data = await res.json();
      setAgentBuyPrice(data.bestBuyPrice);
      setAgentSellPrice(data.sellPrice);
      setAgentResult(
        `Buy at: ${data.bestBuyPrice}\nSell target: ${data.sellPrice || "Not provided"}\n\n${data.reason}\n\nPrediction: ${
          data.prediction || "N/A"
        }`
      );
    } catch (error) {
      console.error(error);
      alert("Error analyzing the chart.");
    }
  };

  const handlePickFromChart = () => {
    if (!selectedStock) return;

    const saved = localStorage.getItem("pnlRows");
    const rows = saved
      ? JSON.parse(saved)
      : [
          { day: "Day 1", date: "", pick: "", price: "", priceToSell: "", invested: "", diff: "" },
          { day: "Day 2", date: "", pick: "", price: "", priceToSell: "", invested: "", diff: "" },
          { day: "Day 3", date: "", pick: "", price: "", priceToSell: "", invested: "", diff: "" },
          { day: "Day 4", date: "", pick: "", price: "", priceToSell: "", invested: "", diff: "" },
          { day: "Day 5", date: "", pick: "", price: "", priceToSell: "", invested: "", diff: "" },
        ];

    const today = new Date().toISOString().split("T")[0];
    const updated = [...rows];
    let found = false;
    for (let i = 0; i < updated.length; i++) {
      if (!updated[i].pick) {
        updated[i].pick = selectedStock;
        updated[i].date = today;
        if (agentBuyPrice) updated[i].price = parseFloat(agentBuyPrice);
        if (agentSellPrice) updated[i].priceToSell = parseFloat(agentSellPrice);
        found = true;
        break;
      }
    }
    if (!found) {
      const newDay = `Day ${updated.length + 1}`;
      updated.push({
        day: newDay,
        date: today,
        pick: selectedStock,
        price: agentBuyPrice ? parseFloat(agentBuyPrice) : "",
        priceToSell: agentSellPrice ? parseFloat(agentSellPrice) : "",
        invested: "",
        diff: "",
      });
    }
    localStorage.setItem("pnlRows", JSON.stringify(updated));
    alert(`Added ${selectedStock} to your P&L with Buy: ${agentBuyPrice}, Sell: ${agentSellPrice}`);
  };

  const resizingConfig = {
    top: true,
    right: true,
    bottom: true,
    left: true,
    topRight: true,
    bottomRight: true,
    bottomLeft: true,
    topLeft: true,
  };

  return (
    <main className="h-screen w-screen bg-gray-100 flex flex-col">
      <Navbar />
      <div id="content-area" className="flex-1 relative">
        {/* AI Recommendation / Bot Box */}
        <Rnd
          bounds="#content-area"
          default={{ x: 20, y: 20, width: 400, height: 600 }}
          minWidth={300}
          minHeight={200}
          enableResizing={resizingConfig}
          className="bg-white rounded shadow-lg flex flex-col z-50"
        >
          <div className="flex flex-col p-4 flex-1">
            <h2 className="font-bold text-lg mb-2">AI Recommendation</h2>

            {/* NEW: Bot daily pick + price box */}
            {botData?.lastRec ? (
              <div className="mb-3 text-sm border rounded p-2 bg-gray-50">
                <div>
                  <b>AI Pick:</b> {botData.lastRec.ticker}
                </div>
                <div>
                  <b>Price:</b> ${Number(botData.lastRec.price).toFixed(2)}
                </div>
                <div>
                  <b>Time:</b>{" "}
                  {new Date(botData.lastRec.at).toLocaleTimeString("en-US", {
                    timeZone: "America/New_York",
                  })}{" "}
                  ET
                </div>
              </div>
            ) : (
              <div className="text-gray-500 text-sm mb-3">
                {botData?.skipped === "market_closed"
                  ? "Market closed. Waiting for next session."
                  : "No recommendation yet today."}
              </div>
            )}

            {/* NEW: Account snapshot */}
            {botData?.state && (
              <div className="mb-3 text-sm border rounded p-2">
                <div>
                  Money I Have: <b>${Number(botData.state.cash).toFixed(2)}</b>
                </div>
                <div>
                  Equity: <b>${Number(botData.state.equity).toFixed(2)}</b>
                </div>
                <div>
                  PNL:{" "}
                  <b className={Number(botData.state.pnl) >= 0 ? "text-green-600" : "text-red-600"}>
                    {Number(botData.state.pnl) >= 0 ? "+" : ""}
                    ${Number(botData.state.pnl).toFixed(2)}
                  </b>
                </div>
                {botData?.live?.ticker && (
                  <div className="mt-1 text-xs text-gray-600">
                    Live: {botData.live.ticker}{" "}
                    {botData.live.price != null ? `$${Number(botData.live.price).toFixed(2)}` : "…"}
                  </div>
                )}
              </div>
            )}

            {/* Manual “Ask AI” (your existing feature) */}
            <button
              onClick={askAIRecommendation}
              disabled={analyzing || stocks.length === 0}
              className={`px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition ${
                (analyzing || stocks.length === 0) && "opacity-60 cursor-not-allowed"
              }`}
              title={stocks.length === 0 ? "No stocks loaded yet" : "Send current 7 to AI"}
            >
              {analyzing ? "Analyzing..." : "Ask AI"}
            </button>

            {recommendation && (
              <div className="mt-4 text-sm whitespace-pre-wrap">{recommendation}</div>
            )}

            {/* Server time (handy for debugging) */}
            <div className="mt-auto text-xs text-gray-500">
              Server ET:{" "}
              {botData?.serverTimeET
                ? new Date(botData.serverTimeET).toLocaleTimeString("en-US", {
                    timeZone: "America/New_York",
                  })
                : "…"}
            </div>
          </div>
        </Rnd>

        {/* Top Gainers Box */}
        <Rnd
          bounds="#content-area"
          default={{ x: 450, y: 20, width: 900, height: 700 }}
          minWidth={500}
          minHeight={500}
          enableResizing={resizingConfig}
          className="bg-white rounded shadow-lg flex flex-col z-50"
        >
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

              <div className="flex items-center gap-2">
                <Button
                  onClick={askAIRecommendation}
                  disabled={analyzing || stocks.length === 0}
                  className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {analyzing ? "Analyzing..." : "Ask AI"}
                </Button>

                <Button
                  onClick={async () => {
                    const target = dataSource === "FMP" ? "alpaca" : "fmp";
                    try {
                      const res = await fetch(`/api/stocks?source=${target}`, { cache: "no-store" });
                      const data = await res.json();
                      if (data.errorMessage) {
                        setErrorMessage(data.errorMessage);
                      } else {
                        setStocks(data.stocks || data);
                        setDataSource(data.sourceUsed || data.source || "");
                      }
                    } catch (err) {
                      console.error("Error switching data source:", err);
                      setErrorMessage("Failed to switch data source.");
                    }
                  }}
                  className="px-3 py-1 bg-gray-800 hover:bg-gray-700 text-white rounded text-sm"
                >
                  Switch
                </Button>
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
                    <tr className="bg-black text-white">
                      {HEADERS.map((h) => (
                        <th key={h} className="p-2">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stocks.map((stock) => (
                      <tr
                        key={stock.ticker}
                        className="hover:bg-gray-100 cursor-pointer"
                        onClick={() => handleStockClick(stock.ticker)}
                      >
                        <td className="border p-2">{stock.ticker}</td>
                        <td className="border p-2">${stock.price}</td>
                        <td
                          className="border p-2"
                          style={{ color: stock.changesPercentage >= 0 ? "green" : "red" }}
                        >
                          {stock.changesPercentage.toFixed(2)}%
                        </td>
                        <td className="border p-2">
                          {stock.marketCap?.toLocaleString() || "-"}
                        </td>
                        <td className="border p-2">
                          {stock.sharesOutstanding?.toLocaleString() || "-"}
                        </td>
                        <td className="border p-2">{stock.volume?.toLocaleString() || "-"}</td>
                        <td className="border p-2">
                          {stock.employees != null ? stock.employees.toLocaleString() : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Rnd>

        {/* TradingView Chart Box */}
        {chartVisible && selectedStock && (
          <Rnd
            bounds="#content-area"
            default={{ x: 1380, y: 20, width: 700, height: 845 }}
            minWidth={300}
            minHeight={200}
            enableResizing={resizingConfig}
            className="bg-white rounded shadow-lg flex flex-col z-50"
          >
            <div className="flex flex-col p-4 flex-1 overflow-auto">
              <h2 className="font-bold mb-2">{selectedStock} Chart</h2>
              <div className="overflow-hidden" style={{ height: "400px" }}>
                <iframe
                  src={`https://s.tradingview.com/widgetembed/?symbol=${selectedStock}&interval=30&hidesidetoolbar=1`}
                  className="w-full h-full"
                  frameBorder="0"
                  scrolling="no"
                />
              </div>
              <div className="flex gap-3 mt-4">
                <button
                  onClick={handleAgent}
                  className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 transition"
                >
                  AI Agent
                </button>
                <button
                  onClick={handlePickFromChart}
                  className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 transition"
                >
                  Pick
                </button>
              </div>
              {agentResult && (
                <div className="mt-4 p-3 bg-gray-100 rounded text-sm whitespace-pre-wrap overflow-y-auto">
                  {agentResult}
                </div>
              )}
            </div>
          </Rnd>
        )}
      </div>
    </main>
  );
}
