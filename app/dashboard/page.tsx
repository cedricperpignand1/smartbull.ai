"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Rnd } from "react-rnd";
import Navbar from "../components/Navbar";
import { Button } from "../components/ui/button";
import TradeNarrator from "../components/TradeNarrator";
import { useBotPoll } from "../components/useBotPoll";

/* ------------------------------
   Tiny title-chip Panel wrapper
   ------------------------------ */
function Panel({
  title,
  color = "blue",
  right,
  children,
}: {
  title: string;
  color?:
    | "blue"
    | "purple"
    | "green"
    | "orange"
    | "rose"
    | "slate"
    | "amber"
    | "cyan";
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  const chip = {
    blue: "bg-blue-600",
    purple: "bg-purple-600",
    green: "bg-emerald-600",
    orange: "bg-orange-600",
    rose: "bg-rose-600",
    slate: "bg-slate-700",
    amber: "bg-amber-500",
    cyan: "bg-cyan-600",
  }[color];

  return (
    <div className="h-full flex flex-col bg-white rounded-2xl border border-zinc-200/70 shadow-[0_8px_24px_rgba(0,0,0,0.06)] overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between">
        <span className={`inline-flex items-center px-3 py-1 rounded-md text-xs font-semibold text-white ${chip}`}>
          {title}
        </span>
        {right}
      </div>
      <div className="px-4 pb-4 pt-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

/* ------------------------------ */

interface Stock {
  ticker: string;
  price: number;
  changesPercentage: number;
  marketCap: number | null;
  sharesOutstanding: number | null;
  volume: number | null;
  avgVolume?: number | null;
  employees?: number | null;
}

interface Trade {
  id: number;
  side: "BUY" | "SELL";
  ticker: string;
  price: number;
  shares: number;
  createdAt?: string;
}

interface TradePayload {
  trades: Trade[];
  openPos: { ticker: string; entryPrice: number; shares: number } | null;
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

  // ---- Stocks & AI analysis ----
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<string>("");
  const [recommendation, setRecommendation] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const [selectedStock, setSelectedStock] = useState<string | null>(null);
  const [chartVisible, setChartVisible] = useState(false);

  const [agentResult, setAgentResult] = useState<string | null>(null);
  const [agentBuyPrice, setAgentBuyPrice] = useState<string | null>(null);
  const [agentSellPrice, setAgentSellPrice] = useState<string | null>(null);

  // ---- Bot/trades state ----
  const [botData, setBotData] = useState<any>(null);
  const [tradeData, setTradeData] = useState<TradePayload | null>(null);
  const { tick: statusTick, trades: statusTrades, error: statusError } = useBotPoll(5000);

  // ---- Reset (admin) modal state ----
  const [showReset, setShowReset] = useState(false);
  const [resetPassword, setResetPassword] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  const HEADERS = ["Symbol", "Price", "Change %", "Market Cap", "Float", "Volume", "Avg Vol", "Employees"];

  // Live stocks via SSE
  useEffect(() => {
    const es = new EventSource("/api/stocks/stream");
    es.onmessage = (evt) => {
      try {
        const obj = JSON.parse(evt.data);
        setStocks(obj?.stocks ?? []);
        setDataSource("FMP (stream)");
        setErrorMessage(null);
        setLoading(false);
      } catch {}
    };
    es.onerror = () => {
      setErrorMessage("Live stream error. Retrying...");
    };
    return () => es.close();
  }, []);

  // Poll /api/bot/tick
  useEffect(() => {
    let id: any;
    const run = async () => {
      try {
        const r = await fetch("/api/bot/tick", { cache: "no-store" });
        const j = await r.json();
        setBotData(j);
      } catch {}
    };
    run();
    id = setInterval(run, 5000);
    return () => clearInterval(id);
  }, []);

  // Poll /api/trades
  useEffect(() => {
    let id: any;
    const run = async () => {
      try {
        const r = await fetch("/api/trades", { cache: "no-store" });
        const j = await r.json();
        if (!j.errorMessage) setTradeData(j);
      } catch {}
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
        body: JSON.stringify({ stocks: stocks.slice(0, 20) }),
      });
      const data = await res.json();
      if (data.errorMessage) setRecommendation(`Error: ${data.errorMessage}`);
      else setRecommendation(data.recommendation || "No recommendation.");
    } catch {
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
    } catch {
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
    let filled = false;
    for (let i = 0; i < updated.length; i++) {
      if (!updated[i].pick) {
        updated[i].pick = selectedStock;
        updated[i].date = today;
        if (agentBuyPrice) updated[i].price = parseFloat(agentBuyPrice);
        if (agentSellPrice) updated[i].priceToSell = parseFloat(agentSellPrice);
        filled = true;
        break;
      }
    }
    if (!filled) {
      updated.push({
        day: `Day ${updated.length + 1}`,
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

  // narrator inputs
  const narratorSymbol =
    selectedStock || botData?.lastRec?.ticker || (tradeData?.openPos?.ticker ?? "");
  const narratorPrice =
    selectedStock
      ? stocks.find((s) => s.ticker === selectedStock)?.price
      : botData?.lastRec?.price ?? tradeData?.openPos?.entryPrice;

  const autoKey =
    tradeData?.openPos
      ? `open:${tradeData.openPos.ticker}@${tradeData.openPos.entryPrice}@${tradeData.openPos.shares}`
      : botData?.lastRec
      ? `pick:${botData.lastRec.ticker}@${botData.lastRec.price}`
      : undefined;

  /* ===== Reset (admin) helpers ===== */
  const openReset = () => { setResetMsg(null); setResetPassword(""); setShowReset(true); };
  const closeReset = () => { if (!resetBusy) setShowReset(false); };
  const confirmReset = async () => {
    setResetBusy(true); setResetMsg(null);
    try {
      const res = await fetch("/api/bot/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: resetPassword }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setResetMsg("Incorrect password or reset failed.");
      } else {
        try {
          localStorage.removeItem("tradeLog_allTime_v2_fifo");
          localStorage.removeItem("pnlRows");
        } catch {}
        setTradeData({ trades: [], openPos: null });
        setResetMsg("✅ Reset complete.");
        setTimeout(() => { setShowReset(false); window.location.reload(); }, 600);
      }
    } catch {
      setResetMsg("Reset error. Check server logs.");
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <main className="min-h-screen w-full bg-gray-100 flex flex-col">
      <Navbar />
      <div
        id="content-area"
        className="flex-1 relative pt-20 px-4 overflow-auto"
        style={{ minWidth: 1800, minHeight: 1300 }}
      >
        {/* AI Recommendation */}
        <Rnd
          bounds="#content-area"
          default={{ x: 16, y: 0, width: 420, height: 650 }}
          minWidth={340}
          minHeight={260}
          enableResizing={resizingConfig}
          className="rounded-2xl border border-zinc-200/60 shadow-none z-40 bg-transparent"
        >
          <Panel title="AI Recommendation" color="blue">
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
                    {Number(botData.state.pnl) >= 0 ? "+" : ""}${Number(botData.state.pnl).toFixed(2)}
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

            {botData?.signals && (
              <div className="mt-2 text-xs bg-gray-50 border rounded p-2">
                <div className="font-semibold">Signals</div>
                <div>Armed: {String(botData.signals.armed)}</div>
                <div>OR High: {botData.signals.orHigh ?? "-"}</div>
                <div>VWAP: {botData.signals.vwap ? Number(botData.signals.vwap).toFixed(2) : "-"}</div>
                <div>VolPulse: {botData.signals.volPulse ? Number(botData.signals.volPulse).toFixed(2) : "-"}</div>
              </div>
            )}

            <Button
              onClick={askAIRecommendation}
              disabled={analyzing || stocks.length === 0}
              className="mt-3 px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 transition disabled:opacity-60 disabled:cursor-not-allowed"
              title={stocks.length === 0 ? "No stocks loaded yet" : "Send current 7 to AI"}
            >
              {analyzing ? "Analyzing..." : "Ask AI"}
            </Button>

            {recommendation && (
              <div className="mt-4 text-sm whitespace-pre-wrap">{recommendation}</div>
            )}

            <div className="mt-auto text-xs text-gray-500">
              Server ET:{" "}
              {botData?.serverTimeET
                ? new Date(botData.serverTimeET).toLocaleTimeString("en-US", {
                    timeZone: "America/New_York",
                  })
                : "…"}
            </div>
          </Panel>
        </Rnd>

        {/* Top Gainers (SSE) */}
        <Rnd
          bounds="#content-area"
          default={{ x: 460, y: 0, width: 980, height: 900 }}
          minWidth={700}
          minHeight={520}
          enableResizing={resizingConfig}
          className="rounded-2xl border border-zinc-200/60 shadow-none z-40 bg-transparent"
        >
          <Panel
            title="Top Gainers"
            color="purple"
            right={
              <div className="flex items-center gap-2">
                <span className="px-2 py-1 rounded-md text-xs font-semibold bg-gray-900 text-white/90">
                  {dataSource || "FMP (stream)"}
                </span>
                <Button
                  onClick={askAIRecommendation}
                  disabled={analyzing || stocks.length === 0}
                  className="px-3 py-1 bg-gray-900 text-white hover:bg-gray-800 rounded-md text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {analyzing ? "Analyzing..." : "Ask AI"}
                </Button>
              </div>
            }
          >
            {loading ? (
              <p>Loading live data…</p>
            ) : errorMessage ? (
              <p className="text-red-600">{errorMessage}</p>
            ) : (
              <div className="flex-1 overflow-auto">
                <table className="min-w-full text-xs sm:text-sm border-separate border-spacing-y-2">
                  <thead>
                    <tr className="bg-black text-white">
                      {HEADERS.map((h, idx) => (
                        <th
                          key={h}
                          className={`p-2 ${idx === 0 ? "rounded-l-xl" : idx === HEADERS.length - 1 ? "rounded-r-xl" : ""}`}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stocks.map((stock) => (
                      <tr
                        key={stock.ticker}
                        className="group cursor-pointer"
                        onClick={() => handleStockClick(stock.ticker)}
                      >
                        <td className="px-3 py-2 bg-white ring-1 ring-gray-200 first:rounded-l-xl group-hover:shadow-md">
                          {stock.ticker}
                        </td>
                        <td className="px-3 py-2 bg-white ring-1 ring-gray-200">
                          {stock.price != null ? `$${Number(stock.price).toFixed(2)}` : "-"}
                        </td>
                        <td
                          className={`px-3 py-2 bg-white ring-1 ring-gray-200 font-medium ${
                            stock.changesPercentage >= 0 ? "text-green-600" : "text-red-600"
                          }`}
                        >
                          {stock.changesPercentage?.toFixed?.(2) ?? "-"}%
                        </td>
                        <td className="px-3 py-2 bg-white ring-1 ring-gray-200">
                          {stock.marketCap != null ? Number(stock.marketCap).toLocaleString() : "-"}
                        </td>
                        <td className="px-3 py-2 bg-white ring-1 ring-gray-200">
                          {stock.sharesOutstanding != null ? Number(stock.sharesOutstanding).toLocaleString() : "-"}
                        </td>
                        <td className="px-3 py-2 bg-white ring-1 ring-gray-200">
                          {stock.volume != null ? Number(stock.volume).toLocaleString() : "-"}
                        </td>
                        <td className="px-3 py-2 bg-white ring-1 ring-gray-200">
                          {stock.avgVolume != null ? Number(stock.avgVolume).toLocaleString() : "-"}
                        </td>
                        <td className="px-3 py-2 bg-white ring-1 ring-gray-200 last:rounded-r-xl">
                          {stock.employees != null ? Number(stock.employees).toLocaleString() : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </Rnd>

        {/* Bot Status */}
        <Rnd
          bounds="#content-area"
          default={{ x: 16, y: 700, width: 420, height: 420 }}
          minWidth={320}
          minHeight={220}
          enableResizing={resizingConfig}
          className="rounded-2xl border border-zinc-200/60 shadow-none z-40 bg-transparent"
        >
          <Panel title="Bot Status" color="green">
            {statusError && <p className="text-red-600 text-sm">Error: {statusError}</p>}

            <div className="rounded-lg px-3 py-2 text-sm mb-3 bg-gray-50 border">
              {(statusTick as any)?.debug?.lastMessage ?? "Waiting for next update…"}
              <div className="mt-1 text-[11px] text-gray-500 space-x-3">
                {typeof statusTick?.info?.snapshotAgeMs === "number" && (
                  <span>Snapshot age: {Math.round(statusTick.info.snapshotAgeMs)} ms</span>
                )}
                {typeof statusTick?.info?.inEntryWindow === "boolean" && (
                  <span>Entry window: {statusTick.info.inEntryWindow ? "OPEN" : "CLOSED"}</span>
                )}
              </div>
            </div>

            <div className="text-sm bg-gray-50 border rounded p-2 mb-2">
              <div>
                Live:{" "}
                {statusTick?.live?.ticker
                  ? `${statusTick.live.ticker} @ ${statusTick.live.price ?? "—"}`
                  : "—"}
              </div>
              <div>
                Server (ET):{" "}
                {statusTick?.serverTimeET
                  ? new Date(statusTick.serverTimeET).toLocaleTimeString("en-US", {
                      timeZone: "America/New_York",
                    })
                  : "—"}
              </div>
            </div>

            <div className="text-xs">
              <div className="font-semibold mb-1">Last Recommendation</div>
              <div className="text-[11px] bg-gray-50 p-2 rounded min-h-[40px]">
                {statusTick?.lastRec
                  ? `Pick: ${statusTick.lastRec.ticker} @ ${
                      typeof statusTick.lastRec.price === "number"
                        ? `$${statusTick.lastRec.price.toFixed(2)}`
                        : "—"
                    }`
                  : "No recommendation yet — bot is waiting for a valid pick."}
              </div>
            </div>

            <div className="text-xs mt-3">
              <div className="font-semibold mb-1">Open Position</div>
              <div className="text-[11px] bg-gray-50 p-2 rounded min-h-[40px]">
                {statusTick?.position
                  ? `Open: ${statusTick.position.ticker} x${statusTick.position.shares} @ $${Number(
                      statusTick.position.entryPrice
                    ).toFixed(2)}`
                  : "No open position — bot will enter only if conditions are met during the entry window."}
              </div>
            </div>

            <div className="text-xs mt-3">
              <div className="font-semibold mb-1">Recent Trades</div>
              <div className="text-[11px] bg-gray-50 p-2 rounded min-h-[40px]">
                {Array.isArray(statusTrades) && statusTrades.length
                  ? `${statusTrades.length} trade${statusTrades.length === 1 ? "" : "s"} today.`
                  : "No trades executed yet today."}
              </div>
            </div>
          </Panel>
        </Rnd>

        {/* Trade Log */}
        <Rnd
          bounds="#content-area"
          default={{ x: 460, y: 940, width: 760, height: 280 }}
          minWidth={520}
          minHeight={220}
          enableResizing={resizingConfig}
          className="rounded-2xl border border-zinc-200/60 shadow-none z-40 bg-transparent"
        >
          <Panel
            title="Trade Log"
            color="orange"
            right={
              <div className="flex items-center gap-2">
                {tradeData?.openPos && (
                  <div className="text-sm bg-gray-900 text-white/90 px-2 py-1 rounded-md">
                    Open: <b>{tradeData.openPos.ticker}</b> @ $
                    {Number(tradeData.openPos.entryPrice).toFixed(2)} • {tradeData.openPos.shares} sh
                  </div>
                )}
                {/* RESET (admin) button — top-right header */}
                <Button
                  onClick={openReset}
                  className="bg-rose-600 hover:bg-rose-700 text-white text-sm px-3 py-1 rounded-md"
                  title="Reset trades/positions/recs (admin)"
                >
                  Reset (admin)
                </Button>
              </div>
            }
          >
            {!tradeData?.trades?.length ? (
              <p className="text-gray-500 text-sm">No trades yet.</p>
            ) : (
              <table className="min-w-full text-xs sm:text-sm">
                <thead>
                  <tr className="bg-gray-900 text-white">
                    <th className="p-2">Time (ET)</th>
                    <th className="p-2">Side</th>
                    <th className="p-2">Ticker</th>
                    <th className="p-2">Price</th>
                    <th className="p-2">Shares</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeData.trades.map((t) => (
                    <tr key={t.id} className="border-b">
                      <td className="p-2">
                        {t.createdAt
                          ? new Date(t.createdAt).toLocaleString("en-US", {
                              timeZone: "America/New_York",
                            })
                          : "-"}
                      </td>
                      <td className="p-2">
                        <span
                          className={`px-2 py-0.5 rounded text-xs ${
                            t.side === "BUY"
                              ? "bg-green-100 text-green-700"
                              : "bg-red-100 text-red-700"
                          }`}
                        >
                          {t.side}
                        </span>
                      </td>
                      <td className="p-2">{t.ticker}</td>
                      <td className="p-2">${Number(t.price).toFixed(2)}</td>
                      <td className="p-2">{t.shares}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </Rnd>

        {/* TradingView Chart */}
        {chartVisible && selectedStock && (
          <Rnd
            bounds="#content-area"
            default={{ x: 1460, y: 0, width: 800, height: 900 }}
            minWidth={420}
            minHeight={260}
            enableResizing={resizingConfig}
            className="rounded-2xl border border-zinc-200/60 shadow-none z-40 bg-transparent"
          >
            <Panel title={`${selectedStock} Chart`} color="slate">
              <div className="overflow-hidden" style={{ height: 420 }}>
                <iframe
                  src={`https://s.tradingview.com/widgetembed/?symbol=${selectedStock}&interval=30&hidesidetoolbar=1`}
                  className="w-full h-full"
                  frameBorder="0"
                  scrolling="no"
                />
              </div>
              <div className="flex gap-3 mt-4">
                <Button
                  onClick={handleAgent}
                  className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 transition"
                >
                  AI Agent
                </Button>
                <Button
                  onClick={handlePickFromChart}
                  className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 transition"
                >
                  Pick
                </Button>
              </div>
              {agentResult && (
                <div className="mt-4 p-3 bg-gray-100 rounded text-sm whitespace-pre-wrap overflow-y-auto">
                  {agentResult}
                </div>
              )}
            </Panel>
          </Rnd>
        )}

        {/* Trade Narrator */}
        <Rnd
          bounds="#content-area"
          default={{ x: 1460, y: 940, width: 800, height: 320 }}
          minWidth={360}
          minHeight={220}
          enableResizing={resizingConfig}
          className="rounded-2xl border border-zinc-200/60 shadow-none z-40 bg-transparent"
        >
          <Panel title="Trade Narrator" color="rose">
            <TradeNarrator
              className="mt-1"
              autoRunKey={autoKey}
              input={{
                symbol: narratorSymbol || "TBD",
                price: typeof narratorPrice === "number" ? narratorPrice : undefined,
                thesis: selectedStock
                  ? "Explaining selected chart context."
                  : tradeData?.openPos
                  ? "Explaining live open position."
                  : botData?.lastRec
                  ? "Explaining latest AI pick context."
                  : "No symbol selected; click a stock to get a focused narration.",
              }}
            />
          </Panel>
        </Rnd>
      </div>

      {/* ===== Password Modal (Reset admin) ===== */}
      {showReset && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) closeReset(); }}
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <div className="text-lg font-semibold text-slate-800">Confirm Reset</div>
            <p className="mt-1 text-sm text-slate-600">
              This wipes all trades, positions, and AI picks, and resets the bot balance.
            </p>

            <label className="block mt-4 text-sm text-slate-700">Password</label>
            <input
              type="password"
              autoFocus
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-rose-500"
              placeholder="Enter password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && resetPassword) confirmReset();
                if (e.key === "Escape") closeReset();
              }}
            />

            {resetMsg && <div className="mt-3 text-sm">{resetMsg}</div>}

            <div className="mt-5 flex items-center justify-end gap-2">
              <Button
                disabled={resetBusy}
                onClick={closeReset}
                className="border border-slate-300 text-slate-700 bg-white hover:bg-slate-50"
              >
                Cancel
              </Button>
              <Button
                disabled={resetBusy || resetPassword.length === 0}
                onClick={confirmReset}
                className="bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-60"
              >
                {resetBusy ? "Resetting…" : "Confirm Reset"}
              </Button>
            </div>

            <div className="mt-3 text-xs text-slate-500">
              Hint: password is <span className="font-semibold">9340</span>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
