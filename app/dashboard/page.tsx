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
}

export default function Home() {
  const { data: session, status } = useSession();

  // Show loading spinner while session is loading
  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-screen">
        Loading...
      </div>
    );
  }

  // Redirect if user not logged in
  if (!session) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-lg font-bold">
          You need to log in to access this page.
        </p>
      </div>
    );
  }

  const [stocks, setStocks] = useState<Stock[]>([]);
  const [loading, setLoading] = useState(true);
  const [recommendation, setRecommendation] = useState<string | null>(null);
  const [selectedStock, setSelectedStock] = useState<string | null>(null);
  const [chartVisible, setChartVisible] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const [agentResult, setAgentResult] = useState<string | null>(null);
  const [agentBuyPrice, setAgentBuyPrice] = useState<string | null>(null);
  const [agentSellPrice, setAgentSellPrice] = useState<string | null>(null);

  const [dataSource, setDataSource] = useState<string>("");

  useEffect(() => {
    fetch("/api/stocks")
      .then((res) => res.json())
      .then((data) => {
        if (data.errorMessage) {
          setErrorMessage(data.errorMessage);
        } else {
          setStocks(data.stocks || data);
          setDataSource(data.source || "");
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error("Error fetching stocks:", err);
        setErrorMessage(
          "Unable to fetch data. You may have run out of API calls on FMP."
        );
        setLoading(false);
      });
  }, []);

  const askAIRecommendation = async () => {
    try {
      setAnalyzing(true);
      setRecommendation(null);

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stocks }),
      });

      if (!res.ok) throw new Error("Failed to analyze stocks");

      const data = await res.json();
      setRecommendation(data.recommendation);
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
        `Buy at: ${data.bestBuyPrice}\nSell target: ${data.sellPrice}\n\n${data.reason}`
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
          {
            day: "Day 1",
            date: "",
            pick: "",
            price: "",
            priceToSell: "",
            invested: "",
            diff: "",
          },
          {
            day: "Day 2",
            date: "",
            pick: "",
            price: "",
            priceToSell: "",
            invested: "",
            diff: "",
          },
          {
            day: "Day 3",
            date: "",
            pick: "",
            price: "",
            priceToSell: "",
            invested: "",
            diff: "",
          },
          {
            day: "Day 4",
            date: "",
            pick: "",
            price: "",
            priceToSell: "",
            invested: "",
            diff: "",
          },
          {
            day: "Day 5",
            date: "",
            pick: "",
            price: "",
            priceToSell: "",
            invested: "",
            diff: "",
          },
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
    alert(
      `Added ${selectedStock} to your P&L with Buy: ${agentBuyPrice}, Sell: ${agentSellPrice}`
    );
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
        {/* AI Recommendation Box */}
        <Rnd
          bounds="#content-area"
          default={{ x: 20, y: 20, width: 400, height: 300 }}
          minWidth={300}
          minHeight={200}
          enableResizing={resizingConfig}
          className="bg-white rounded shadow-lg flex flex-col"
        >
         <div className="flex flex-col p-4 flex-1">
  <h2 className="font-bold text-lg mb-2">AI Recommendation</h2>
  <button
    onClick={askAIRecommendation}
    disabled={analyzing}
    className={`px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition ${
      analyzing && "opacity-60 cursor-not-allowed"
    }`}
  >
    {analyzing ? "Analyzing..." : "Ask AI"}
  </button>

  {recommendation && (
    <div className="mt-4 text-sm whitespace-pre-wrap">
      {recommendation}
    </div>
  )}
</div>

        </Rnd>

        {/* Top Gainers Box */}
        <Rnd
          bounds="#content-area"
          default={{ x: 450, y: 20, width: 700, height: 400 }}
          minWidth={400}
          minHeight={200}
          enableResizing={resizingConfig}
          className="bg-white rounded shadow-lg flex flex-col"
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

              {/* Switch Button */}
              <Button
                onClick={async () => {
                  const target = dataSource === "FMP" ? "alpaca" : "fmp";

                  try {
                    const res = await fetch(`/api/stocks?source=${target}`);
                    const data = await res.json();
                    if (data.errorMessage) {
                      setErrorMessage(data.errorMessage);
                    } else {
                      setStocks(data.stocks || data);
                      setDataSource(data.source || "");
                    }
                  } catch (err) {
                    console.error("Error switching data source:", err);
                    setErrorMessage("Failed to switch data source.");
                  }
                }}
                className="px-3 py-1 bg-gray-800 hover:bg-gray-300 rounded text-sm"
              >
                Switch
              </Button>
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
                      <tr
                        key={i}
                        className="hover:bg-gray-100 cursor-pointer"
                        onClick={() => handleStockClick(stock.ticker)}
                      >
                        <td className="border p-2">{stock.ticker}</td>
                        <td className="border p-2">${stock.price}</td>
                        <td className="border p-2 text-green-600">
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
        </Rnd>

        {/* TradingView Chart Box */}
        {chartVisible && selectedStock && (
          <Rnd
            bounds="#content-area"
            default={{ x: 1200, y: 20, width: 700, height: 700 }}
            minWidth={300}
            minHeight={200}
            enableResizing={resizingConfig}
            className="bg-white rounded shadow-lg flex flex-col"
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
