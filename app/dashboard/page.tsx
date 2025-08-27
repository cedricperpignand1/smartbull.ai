"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Rnd } from "react-rnd";
import Navbar from "../components/Navbar";
import { Button } from "../components/ui/button";
import { useBotPoll } from "../components/useBotPoll";

/* =========================================================
   Reusable Panel — thicker border & clearer outline
   ========================================================= */
function Panel({
  title,
  color = "blue",
  right,
  children,
  dense = false,
}: {
  title: string;
  color?: "blue" | "purple" | "green" | "orange" | "rose" | "slate" | "amber" | "cyan";
  right?: React.ReactNode;
  children: React.ReactNode;
  /** smaller inner padding (helps reduce empty white space) */
  dense?: boolean;
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
    <div className="h-full flex flex-col bg-white rounded-2xl border-[0.5px] border-gray-200 shadow-[0_8px_24px_rgba(0,0,0,0.06)] overflow-hidden">
      <div className="px-4 py-2.5 flex items-center justify-between border-b border-gray-200/80 bg-white">
        <span className={`inline-flex items-center px-3 py-1 rounded-md text-xs font-semibold text-white ${chip}`}>
          {title}
        </span>
        {right}
      </div>
      <div className={`flex-1 overflow-auto ${dense ? "p-3" : "px-4 pb-4 pt-3"}`}>{children}</div>
    </div>
  );
}

/* =========================================================
   Simple in-page AI Chat
   ========================================================= */
function ChatBox() {
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollId = "ai-chat-scroll";

  useEffect(() => {
    const el = document.getElementById(scrollId);
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send() {
    const q = input.trim();
    if (!q || busy) return;
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: q }]);
    setInput("");

    try {
      const r = await fetch("/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q }),
      });
      const j = await r.json();
      setMessages((m) => [...m, { role: "assistant", content: j?.reply ?? "Hmm, I couldn't parse that." }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "Error reaching chat API." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div id={scrollId} className="flex-1 overflow-auto rounded-xl border border-gray-300 bg-gray-50 p-3 space-y-2">
        {!messages.length && (
          <div className="text-sm text-gray-600">
            Ask me things like:
            <br />• what did you trade today?
            <br />• did you make money today?
            <br />• are you in a position?
            <br />• what ticker did you trade today?
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm ${
              m.role === "user" ? "bg-black text-white ml-auto" : "bg-white text-gray-900 border border-gray-200"
            }`}
          >
            {m.content}
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          className="flex-1 rounded-xl border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Type your question…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={busy}
        />
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          className="rounded-xl bg-blue-600 text-white px-4 py-2 text-sm disabled:opacity-60"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

/* =========================================================
   Types
   ========================================================= */
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
  id: number | string;
  side: "BUY" | "SELL";
  ticker: string;
  price: number;
  shares: number;
  createdAt?: string | number | null;
  time?: string | number | null;
  ts?: number | null;
  at?: string | number | null;
  filledAt?: string | number | null;
  executedAt?: string | number | null;
}
interface TradePayload {
  trades: Trade[];
  openPos: { ticker: string; entryPrice: number; shares: number } | null;
}

/** ---- Alpaca account types (for real balances/PnL) ---- */
type AlpacaAccount = {
  cash: number | null;
  equity: number | null;
  last_equity: number | null;
  buying_power: number | null;
  day_pnl: number | null;
  day_pnl_pct: number | null;
  timestampET: string;
};

/* =========================================================
   Time helpers
   ========================================================= */
function pickMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : null;
}
function formatETFromTrade(t: Trade): string {
  const ms =
    pickMs(t.createdAt) ??
    pickMs(t.time) ??
    pickMs(t.ts) ??
    pickMs(t.at) ??
    pickMs(t.filledAt) ??
    pickMs(t.executedAt);
  if (!ms) return "-";
  return new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York" });
}
function ymdET(d: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${day}`;
}

/* =========================================================
   Draggable layout helpers
   ========================================================= */
type Rect = { x: number; y: number; width: number; height: number };
type Layout = {
  chat: Rect;
  gainers: Rect;
  tradelog: Rect;
  airec: Rect;
  botstatus: Rect;
};

const LAYOUT_KEY = "dash_layout_v5";

/** Defaults tuned to your last screenshot */
function computeDefaultLayout(w: number, h: number): Layout {
  const gap = 22;          // spacing between boxes
  const left = 460;        // AI Chat width (wider)
  const halfRight = 480;   // width of each bottom-right half
  const rightTotal = halfRight * 2 + gap;

  // Trade Log takes ~40–45% height; bottom row uses rest (less blank space)
  const tradeH = Math.max(300, Math.min(420, Math.round(h * 0.44)));
  const bottomH = Math.max(240, h - (tradeH + gap));

  const xLeft = 0;
  const xCenter = left + gap;
  const center = Math.max(720, w - (left + gap + rightTotal + gap));
  const xRight = xCenter + center + gap;
  const xRight2 = xRight + halfRight + gap;

  return {
    chat: { x: xLeft, y: 0, width: left, height: h },
    gainers: { x: xCenter, y: 0, width: center, height: h },
    tradelog: { x: xRight, y: 0, width: rightTotal, height: tradeH },
    airec: { x: xRight, y: tradeH + gap, width: halfRight, height: bottomH },
    botstatus: { x: xRight2, y: tradeH + gap, width: halfRight, height: bottomH },
  };
}

/* =========================================================
   Page
   ========================================================= */
export default function Home() {
  const { data: session, status } = useSession();
  if (status === "loading") return <div className="flex items-center justify-center h-screen">Loading...</div>;
  if (!session)
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-lg font-bold">You need to log in to access this page.</p>
      </div>
    );

  // Stocks & AI analysis
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

  // Bot / trades
  const [botData, setBotData] = useState<any>(null);
  const [tradeData, setTradeData] = useState<TradePayload | null>(null);
  const { tick: statusTick, tradesToday: statusTradesToday, error: statusError } = useBotPoll(5000);

  // ---- NEW: real Alpaca account state ----
  const [alpaca, setAlpaca] = useState<AlpacaAccount | null>(null);

  // SSE: stocks
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
    es.onerror = () => setErrorMessage("Live stream error. Retrying...");
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

  // Poll /api/trades (today by default from your backend)
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

  // ---- NEW: poll /api/alpaca/account every 10s ----
  useEffect(() => {
    let id: any;
    const run = async () => {
      try {
        const r = await fetch("/api/alpaca/account", { cache: "no-store" });
        const j = await r.json();
        if (j?.ok && j?.account) setAlpaca(j.account as AlpacaAccount);
      } catch {}
    };
    run();
    id = setInterval(run, 10_000);
    return () => clearInterval(id);
  }, []);

  // Ask AI recs
  const askAIRecommendation = async () => {
    try {
      setAnalyzing(true);
      setRecommendation(null);

      const res = await fetch("/api/recommendation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stocks: stocks.slice(0, 20), topN: 2 }),
      });
      const data = await res.json();

      if (!res.ok || data?.errorMessage) {
        setRecommendation(`Error: ${data?.errorMessage || res.statusText}`);
        return;
      }

      const picks: string[] = Array.isArray(data?.picks) ? data.picks : [];
      const reasons: Record<string, string[]> = data?.reasons || {};
      const risk: string = data?.risk || "";

      const lines: string[] = [];
      if (picks[0]) {
        lines.push(`Top 1: ${picks[0]}`);
        if (Array.isArray(reasons[picks[0]]) && reasons[picks[0]].length) lines.push(`  • ${reasons[picks[0]].join("\n  • ")}`);
      }
      if (picks[1]) {
        lines.push("");
        lines.push(`Top 2: ${picks[1]}`);
        if (Array.isArray(reasons[picks[1]]) && reasons[picks[1]].length) lines.push(`  • ${reasons[picks[1]].join("\n  • ")}`);
      }
      if (risk) {
        lines.push("");
        lines.push(`Risk: ${risk}`);
      }
      setRecommendation(lines.join("\n") || "No recommendation.");
    } catch {
      setRecommendation("Failed to analyze stocks. Check server logs.");
    } finally {
      setAnalyzing(false);
    }
  };

  // Chart helpers
  const handleStockClick = (ticker: string) => {
    setSelectedStock(ticker);
    setChartVisible(true);
    setAgentResult(null);
    setAgentBuyPrice(null);
    setAgentSellPrice(null);
  };
  const closeChart = () => {
    setChartVisible(false);
    setSelectedStock(null);
    setAgentResult(null);
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

  // Reset (admin)
  const [showReset, setShowReset] = useState(false);
  const [resetPassword, setResetPassword] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const closeReset = () => !resetBusy && setShowReset(false);
  const confirmReset = async () => {
    setResetBusy(true);
    setResetMsg(null);
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
          localStorage.removeItem(LAYOUT_KEY);
        } catch {}
        setTradeData({ trades: [], openPos: null });
        setResetMsg("✅ Reset complete.");
        setTimeout(() => {
          setShowReset(false);
          window.location.reload();
        }, 600);
      }
    } catch {
      setResetMsg("Reset error. Check server logs.");
    } finally {
      setResetBusy(false);
    }
  };

  // today's trades count (fallback)
  const todayTradeCount = useMemo(() => {
    if (Array.isArray(statusTradesToday)) return statusTradesToday.length;
    const all = tradeData?.trades || [];
    if (!all.length) return 0;
    const todayKey = ymdET(new Date());
    let n = 0;
    for (const t of all) {
      const ms =
        pickMs(t.createdAt) ?? pickMs(t.time) ?? pickMs(t.ts) ?? pickMs(t.at) ?? pickMs(t.filledAt) ?? pickMs(t.executedAt);
      if (!ms) continue;
      if (ymdET(new Date(ms)) === todayKey) n++;
    }
    return n;
  }, [statusTradesToday, tradeData]);

  /* ====== draggable dashboard state ====== */
  const contentRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<{ w: number; h: number } | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const measure = () => {
      const r = el.getBoundingClientRect();
      setContainer({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(el);

    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) setLayout(JSON.parse(raw));
    } catch {}

    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    if (!container) return;
    if (!layout) setLayout(computeDefaultLayout(container.w, container.h));
  }, [container, layout]);

  const saveLayout = (next: Layout) => {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
    } catch {}
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

  const HEADERS = ["Symbol", "Price", "Change %", "Market Cap", "Float", "Volume", "Avg Vol", "Employees"];

  return (
    <main className="min-h-screen w-full bg-gray-100 flex flex-col">
      <Navbar />
      <div
        id="content-area"
        ref={contentRef}
        className="relative flex-1 px-4 pt-20 overflow-hidden"
        style={{ height: "calc(100vh - 112px)" }}
      >
        {layout && (
          <>
            {/* AI Chat — wider left column */}
            <Rnd
              bounds="#content-area"
              default={{ x: layout.chat.x, y: layout.chat.y, width: layout.chat.width, height: layout.chat.height }}
              minWidth={380}
              minHeight={260}
              dragGrid={[10, 10]}
              resizeGrid={[10, 10]}
              enableResizing={resizingConfig}
              onDragStop={(_, d) => saveLayout({ ...layout, chat: { ...layout.chat, x: d.x, y: d.y } })}
              onResizeStop={(_, __, ref, _delta, pos) =>
                saveLayout({ ...layout, chat: { x: pos.x, y: pos.y, width: ref.offsetWidth, height: ref.offsetHeight } })
              }
              className="rounded-2xl border-[0.5px] border-gray-200 shadow-none z-40 bg-transparent"
            >
              <Panel title="AI Chat" color="cyan" dense>
                <ChatBox />
              </Panel>
            </Rnd>

            {/* Top Gainers — big center */}
            <Rnd
              bounds="#content-area"
              default={{ x: layout.gainers.x, y: layout.gainers.y, width: layout.gainers.width, height: layout.gainers.height }}
              minWidth={720}
              minHeight={420}
              dragGrid={[10, 10]}
              resizeGrid={[10, 10]}
              enableResizing={resizingConfig}
              onDragStop={(_, d) => saveLayout({ ...layout, gainers: { ...layout.gainers, x: d.x, y: d.y } })}
              onResizeStop={(_, __, ref, _delta, pos) =>
                saveLayout({
                  ...layout,
                  gainers: { x: pos.x, y: pos.y, width: ref.offsetWidth, height: ref.offsetHeight },
                })
              }
              className="rounded-2xl border-[0.5px] border-gray-200 shadow-none z-40 bg-transparent"
            >
              <Panel
                title="Top Gainers"
                color="purple"
                dense
                right={
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-1 rounded-md text-xs font-semibold bg-gray-900 text-white/90">
                      {dataSource || "FMP (stream)"}
                    </span>
                    <Button
                      onClick={askAIRecommendation}
                      disabled={analyzing || stocks.length === 0}
                      className="px-3 py-1 bg-gray-900 text-white hover:bg-gray-800 rounded-md text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                      title={stocks.length === 0 ? "No stocks loaded yet" : "Send list to AI (Top 1 & Top 2)"}
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
                  <div className="h-full overflow-auto">
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

            {/* Trade Log — top-right (wide) */}
            <Rnd
              bounds="#content-area"
              default={{ x: layout.tradelog.x, y: layout.tradelog.y, width: layout.tradelog.width, height: layout.tradelog.height }}
              minWidth={940}
              minHeight={260}
              dragGrid={[10, 10]}
              resizeGrid={[10, 10]}
              enableResizing={resizingConfig}
              onDragStop={(_, d) => saveLayout({ ...layout, tradelog: { ...layout.tradelog, x: d.x, y: d.y } })}
              onResizeStop={(_, __, ref, _delta, pos) =>
                saveLayout({
                  ...layout,
                  tradelog: { x: pos.x, y: pos.y, width: ref.offsetWidth, height: ref.offsetHeight },
                })
              }
              className="rounded-2xl border-[0.5px] border-gray-300 shadow-none z-40 bg-transparent"
            >
              <Panel
                title="Trade Log"
                color="orange"
                dense
                right={
                  <div className="flex items-center gap-2">
                    {tradeData?.openPos && (
                      <div className="text-sm bg-gray-900 text-white/90 px-2 py-1 rounded-md">
                        Open: <b>{tradeData.openPos.ticker}</b> @ ${Number(tradeData.openPos.entryPrice).toFixed(2)} •{" "}
                        {tradeData.openPos.shares} sh
                      </div>
                    )}
                    <Button
                      onClick={() => setShowReset(true)}
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
                  <div className="h-full overflow-auto">
                    <table className="min-w-full text-xs sm:text-sm border-separate border-spacing-y-2">
                      <thead>
                        <tr className="bg-black text-white">
                          {["Time (ET)", "Side", "Ticker", "Price", "Shares"].map((h, idx, arr) => (
                            <th
                              key={h}
                              className={`p-2 ${idx === 0 ? "rounded-l-xl" : idx === arr.length - 1 ? "rounded-r-xl" : ""}`}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {tradeData.trades.map((t) => (
                          <tr key={String(t.id)} className="group">
                            <td className="px-3 py-2 bg-white ring-1 ring-gray-200 first:rounded-l-xl group-hover:shadow-md">
                              {formatETFromTrade(t)}
                            </td>
                            <td className="px-3 py-2 bg-white ring-1 ring-gray-200">
                              <span
                                className={`px-2 py-0.5 rounded text-xs font-semibold ${
                                  t.side === "BUY" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                                }`}
                              >
                                {t.side}
                              </span>
                            </td>
                            <td className="px-3 py-2 bg-white ring-1 ring-gray-200">{t.ticker}</td>
                            <td className="px-3 py-2 bg-white ring-1 ring-gray-200">${Number(t.price).toFixed(2)}</td>
                            <td className="px-3 py-2 bg-white ring-1 ring-gray-200 last:rounded-r-xl">{t.shares}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </Rnd>

            {/* AI Recommendation — bottom-right left */}
            <Rnd
              bounds="#content-area"
              default={{ x: layout.airec.x, y: layout.airec.y, width: layout.airec.width, height: layout.airec.height }}
              minWidth={420}
              minHeight={220}
              dragGrid={[10, 10]}
              resizeGrid={[10, 10]}
              enableResizing={resizingConfig}
              onDragStop={(_, d) => saveLayout({ ...layout, airec: { ...layout.airec, x: d.x, y: d.y } })}
              onResizeStop={(_, __, ref, _delta, pos) =>
                saveLayout({
                  ...layout,
                  airec: { x: pos.x, y: pos.y, width: ref.offsetWidth, height: ref.offsetHeight },
                })
              }
              className="rounded-2xl border-[0.5px] border-gray-200 shadow-none z-40 bg-transparent"
            >
              <Panel title="AI Recommendation" color="blue" dense>
                {botData?.lastRec ? (
                  <div className="mb-3 text-sm border border-gray-200 rounded p-2 bg-gray-50">
                    <div><b>AI Pick:</b> {botData.lastRec.ticker}</div>
                    <div><b>Price:</b> {typeof botData.lastRec.price === "number" ? `$${Number(botData.lastRec.price).toFixed(2)}` : "—"}</div>
                    <div>
                      <b>Time:</b>{" "}
                      {botData.lastRec.at
                        ? new Date(botData.lastRec.at).toLocaleTimeString("en-US", { timeZone: "America/New_York" })
                        : "—"}{" "}
                      ET
                    </div>
                  </div>
                ) : (
                  <div className="text-gray-600 text-sm mb-3">
                    {botData?.skipped === "market_closed" ? "Market closed. Waiting for next session." : "No recommendation yet today."}
                  </div>
                )}

                {/* ---- NEW: Prefer real Alpaca balances/PnL; fallback to bot state ---- */}
                {(alpaca || botData?.state) && (
                  <div className="mb-3 text-sm border border-gray-200 rounded p-2">
                    {(() => {
                      const money = alpaca?.cash ?? botData?.state?.cash ?? null;
                      const eq    = alpaca?.equity ?? botData?.state?.equity ?? null;
                      const dayPnl = alpaca?.day_pnl ?? botData?.state?.pnl ?? null;

                      return (
                        <>
                          <div>
                            Money I Have:{" "}
                            <b>{money != null ? `$${Number(money).toFixed(2)}` : "—"}</b>{" "}
                            {alpaca && <span className="text-xs text-gray-500">(Alpaca)</span>}
                          </div>
                          <div>
                            Equity:{" "}
                            <b>{eq != null ? `$${Number(eq).toFixed(2)}` : "—"}</b>{" "}
                            {alpaca && <span className="text-xs text-gray-500">(Alpaca)</span>}
                          </div>
                          <div>
                            PNL:{" "}
                            <b className={Number(dayPnl ?? 0) >= 0 ? "text-green-600" : "text-red-600"}>
                              {dayPnl != null
                                ? `${Number(dayPnl) >= 0 ? "+" : "-"}$${Math.abs(Number(dayPnl)).toFixed(2)}`
                                : "—"}
                            </b>{" "}
                            {alpaca && <span className="text-xs text-gray-500">(Today, Alpaca)</span>}
                          </div>
                          {alpaca?.day_pnl_pct != null && (
                            <div className="text-xs text-gray-600">
                              Day PnL %: {(alpaca.day_pnl_pct * 100).toFixed(2)}%
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}

                <Button
                  onClick={askAIRecommendation}
                  disabled={analyzing || stocks.length === 0}
                  className="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 transition disabled:opacity-60 disabled:cursor-not-allowed"
                  title={stocks.length === 0 ? "No stocks loaded yet" : "Send list to AI (Top 1 & Top 2)"}
                >
                  {analyzing ? "Analyzing..." : "Ask AI"}
                </Button>

                {recommendation && <div className="mt-3 text-sm whitespace-pre-wrap">{recommendation}</div>}
                <div className="mt-2 text-xs text-gray-500">
                  Server ET: {botData?.serverTimeET ? new Date(botData.serverTimeET).toLocaleTimeString("en-US", { timeZone: "America/New_York" }) : "…"}
                </div>
              </Panel>
            </Rnd>

            {/* Bot Status — bottom-right right */}
            <Rnd
              bounds="#content-area"
              default={{ x: layout.botstatus.x, y: layout.botstatus.y, width: layout.botstatus.width, height: layout.botstatus.height }}
              minWidth={420}
              minHeight={220}
              dragGrid={[10, 10]}
              resizeGrid={[10, 10]}
              enableResizing={resizingConfig}
              onDragStop={(_, d) => saveLayout({ ...layout, botstatus: { ...layout.botstatus, x: d.x, y: d.y } })}
              onResizeStop={(_, __, ref, _delta, pos) =>
                saveLayout({
                  ...layout,
                  botstatus: { x: pos.x, y: pos.y, width: ref.offsetWidth, height: ref.offsetHeight },
                })
              }
              className="rounded-2xl border-[0.5px] border-gray-200 shadow-none z-40 bg-transparent"
            >
              <Panel title="Bot Status" color="green" dense>
                {statusError && <p className="text-red-600 text-sm">Error: {statusError}</p>}

                <div className="rounded-lg px-3 py-2 text-sm mb-2 bg-gray-50 border border-gray-200">
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

                <div className="text-sm bg-gray-50 border border-gray-200 rounded p-2 mb-2">
                  <div>Live: {statusTick?.live?.ticker ? `${statusTick.live.ticker} @ ${statusTick.live.price ?? "—"}` : "—"}</div>
                  <div>
                    Server (ET):{" "}
                    {statusTick?.serverTimeET
                      ? new Date(statusTick.serverTimeET).toLocaleTimeString("en-US", { timeZone: "America/New_York" })
                      : "—"}
                  </div>
                </div>

                <div className="text-xs">
                  <div className="font-semibold mb-1">Last Recommendation</div>
                  <div className="text-[11px] bg-gray-50 border border-gray-200 p-2 rounded">
                    {statusTick?.lastRec
                      ? `Pick: ${statusTick.lastRec.ticker} @ ${
                          typeof statusTick.lastRec.price === "number" ? `$${statusTick.lastRec.price.toFixed(2)}` : "—"
                        }`
                      : "No recommendation yet — bot is waiting for a valid pick."}
                  </div>
                </div>

                <div className="text-xs mt-2">
                  <div className="font-semibold mb-1">Open Position</div>
                  <div className="text-[11px] bg-gray-50 border border-gray-200 p-2 rounded">
                    {statusTick?.position
                      ? `Open: ${statusTick.position.ticker} x${statusTick.position.shares} @ $${Number(
                          statusTick.position.entryPrice
                        ).toFixed(2)}`
                      : "No open position — bot will enter only if conditions are met during the entry window."}
                  </div>
                </div>

                <div className="text-xs mt-2">
                  <div className="font-semibold mb-1">Recent Trades</div>
                  <div className="text-[11px] bg-gray-50 border border-gray-200 p-2 rounded">
                    {todayTradeCount
                      ? `${todayTradeCount} trade${todayTradeCount === 1 ? "" : "s"} today (ET).`
                      : "No trades executed yet today."}
                  </div>
                </div>
              </Panel>
            </Rnd>
          </>
        )}

        {/* Chart overlay */}
        {chartVisible && selectedStock && (
          <Rnd
            bounds="#content-area"
            default={{ x: (container?.w || 1200) - 880, y: (container?.h || 800) - 580, width: 860, height: 560 }}
            minWidth={420}
            minHeight={260}
            dragGrid={[10, 10]}
            resizeGrid={[10, 10]}
            enableResizing={resizingConfig}
            className="rounded-2xl border-[0.5px] border-gray-200 shadow-xl z-50 bg-transparent"
          >
            <Panel
              title={`${selectedStock} Chart`}
              color="slate"
              right={
                <button
                  onClick={closeChart}
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-slate-300 text-slate-600 hover:bg-slate-100"
                  aria-label="Close chart"
                  title="Close chart"
                >
                  ×
                </button>
              }
              dense
            >
              <div className="overflow-hidden" style={{ height: 420 }}>
                <iframe
                  src={`https://s.tradingview.com/widgetembed/?symbol=${selectedStock}&interval=30&hidesidetoolbar=1`}
                  className="w-full h-full"
                  frameBorder="0"
                  scrolling="no"
                />
              </div>
              <div className="flex gap-3 mt-3">
                <Button onClick={handleAgent} className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 transition">
                  AI Agent
                </Button>
                <Button onClick={handlePickFromChart} className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 transition">
                  Pick
                </Button>
              </div>
              {agentResult && (
                <div className="mt-3 p-3 bg-gray-100 border border-gray-200 rounded text-sm whitespace-pre-wrap overflow-y-auto">
                  {agentResult}
                </div>
              )}
            </Panel>
          </Rnd>
        )}
      </div>

      {/* Reset admin modal */}
      {showReset && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeReset();
          }}
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl border-1 border-gray-300">
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
              <Button disabled={resetBusy} onClick={closeReset} className="border border-slate-300 text-slate-700 bg-white hover:bg-slate-50">
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
              Hint: password is <span className="font-semibold">Fuck OFF</span>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
