"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useSession } from "next-auth/react";
import Navbar from "../components/Navbar";
import { Button } from "../components/ui/button";
import { useBotPoll } from "../components/useBotPoll";

/* =========================================================
   Lazy components (no SSR)
========================================================= */
const TradeChartPanel = dynamic<{
  height?: number;
  symbolWhenFlat?: string;
}>(() => import("../components/TradeChartPanel"), { ssr: false });

const TradingViewChart = dynamic<
  {
    symbol: string;
    height?: number;
    theme?: "light" | "dark";
    interval?: "1" | "3" | "5" | "15" | "30" | "60" | "120" | "240" | "D";
    timezone?: string;
  }
>(() => import("../components/TradingViewChart").then((m) => m.default), {
  ssr: false,
});

/* =========================================================
   Constants & ET helpers
========================================================= */
const CHAT_FIXED_HEIGHT_PX = 1100;

function nowET(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}
function isMarketOpenET(d = nowET()): boolean {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const h = d.getHours();
  const m = d.getMinutes();
  const afterOpen = h > 9 || (h === 9 && m >= 30);
  const beforeClose = h < 16;
  return afterOpen && beforeClose;
}
function inNarrationWindowET(d = nowET()): boolean {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= 9 * 60 + 30 && mins < 9 * 60 + 45;
}

/* =========================================================
   OPAQUE Panel shell
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
    <div className="h-full flex flex-col bg-white rounded-2xl border border-gray-200 shadow-[0_8px_24px_rgba(0,0,0,0.06)] overflow-hidden">
      <div className="px-4 py-2.5 flex items-center justify-between border-b border-gray-200 bg-white">
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
   GLASS Panel (AI Chat)
========================================================= */
function GlassPanel({
  title,
  color = "cyan",
  right,
  children,
  dense = false,
}: {
  title: string;
  color?: "blue" | "purple" | "green" | "orange" | "rose" | "slate" | "amber" | "cyan";
  right?: React.ReactNode;
  children: React.ReactNode;
  dense?: boolean;
}) {
  const chip = {
    blue: "from-blue-500 to-blue-600",
    purple: "from-purple-500 to-purple-600",
    green: "from-emerald-500 to-emerald-600",
    orange: "from-orange-500 to-orange-600",
    rose: "from-rose-500 to-rose-600",
    slate: "from-slate-700 to-slate-800",
    amber: "from-amber-500 to-amber-600",
    cyan: "from-cyan-500 to-cyan-600",
  }[color];

  return (
    <div className="h-full flex flex-col rounded-3xl overflow-hidden bg-white/28 backdrop-blur-xl ring-1 ring-white/40 shadow-[0_10px_35px_rgba(0,0,0,0.18)]">
      <div className="px-4 py-3 flex items-center justify-between">
        <span className={`inline-flex items-center px-3 py-1 rounded-lg text-[11px] font-semibold text-white bg-gradient-to-br ${chip}`}>
          {title}
        </span>
        {right}
      </div>
      <div className={`${dense ? "p-3" : "px-4 pt-2 pb-0"} flex-1 min-h-0 overflow-hidden`}>{children}</div>
    </div>
  );
}

/* =========================================================
   Floating Narrator (unchanged logic, small class fix)
========================================================= */
function FloatingNarrator() {
  const [speaking, setSpeaking] = useState(false);
  const [caption, setCaption] = useState<string>("Narrator idle. Tap the mic to start.");
  const controllerRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<string>("");

  const isActive = () =>
    speaking ||
    !!controllerRef.current ||
    (typeof window !== "undefined" &&
      !!window.speechSynthesis &&
      (window.speechSynthesis.speaking || window.speechSynthesis.pending));

  const speakSentence = (sentence: string) => {
    if (!window.speechSynthesis) return;
    const s = sentence.trim();
    if (!s || s.length < 2) return;
    const u = new SpeechSynthesisUtterance(s);
    u.rate = 1.02;
    u.pitch = 1.0;
    u.volume = 1.0;
    u.onstart = () => {
      setCaption(s);
      setSpeaking(true);
    };
    u.onend = () => {
      setTimeout(() => {
        const still = window.speechSynthesis.speaking || window.speechSynthesis.pending;
        if (!still && !controllerRef.current) setSpeaking(false);
      }, 60);
    };
    window.speechSynthesis.speak(u);
  };

  const stopAll = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    try {
      window.speechSynthesis?.cancel();
    } catch {}
    setSpeaking(false);
    setCaption("Narration stopped.");
  };

  const start = async () => {
    if (controllerRef.current) return;
    try {
      window.speechSynthesis?.getVoices();
    } catch {}

    const ac = new AbortController();
    controllerRef.current = ac;
    pendingRef.current = "";
    setCaption("Listening to tape…");

    try {
      const res = await fetch("/api/trade-narrate/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: ac.signal,
      });
      if (!res.body) throw new Error("No stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();

      setSpeaking(true);

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        pendingRef.current += chunk;

        const parts = pendingRef.current.split(/(?<=[\.\?!])\s+|\n+/g);
        pendingRef.current = parts.pop() ?? "";

        for (const s of parts) speakSentence(s);
      }
    } catch {
      // aborted or network issue
    } finally {
      controllerRef.current = null;
      const tail = (pendingRef.current || "").trim();
      if (tail) speakSentence(tail);
      pendingRef.current = "";
      if (!window.speechSynthesis?.speaking) setSpeaking(false);
    }
  };

  const toggle = () => (isActive() ? stopAll() : start());
  const active = isActive();

  useEffect(() => {
    if (typeof window === "undefined") return;

    const tick = () => {
      const visible = document.visibilityState === "visible";
      const inWin = inNarrationWindowET();

      if (inWin && visible && !isActive()) start();
      if ((!inWin || !visible) && isActive()) stopAll();
    };

    tick();
    const id = setInterval(tick, 5000);
    const onVis = () => tick();
    document.addEventListener("visibilitychange", onVis);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <div className="w-full flex items-center gap-5 px-1">
      <button
        onClick={toggle}
        aria-label={active ? "Stop Narrator" : "Start Narrator"}
        className={[
          "relative inline-flex items-center justify-center h-16 w-16 rounded-full transition",
          active
            ? "bg-emerald-500 text-white shadow-[0_0_0_14px_rgba(16,185,129,0.35)] animate-pulse"
            : "bg-white/30 ring-1 ring-white/50 text-white hover:bg-white/40",
        ].join(" ")}
        title={active ? "Stop Narrator" : "Start Narrator"}
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24" className="h-8 w-8">
          <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V20H8v2h8v-2h-3v-2.08A7 7 0 0 0 19 11h-2z" />
        </svg>
      </button>

      <div className="max-w-[min(82vw,1100px)] text-white text-[18px] md:text-[20px] leading-7 font-semibold bg-black/35 rounded-xl px-4 py-1.5 backdrop-blur-sm select-none">
        {caption}
      </div>
    </div>
  );
}

/* =========================================================
   Types for the rest of the page
========================================================= */
interface Stock {
  ticker: string;
  price: number | null;
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
   Time helpers (for counts)
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
   Page (positions chart + modal TV chart)
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

  const OPEN_BG = "/bluebackground.jpg";
  const CLOSED_BG = "/nightbackground.png";
  const [bgUrl, setBgUrl] = useState<string>(isMarketOpenET() ? OPEN_BG : CLOSED_BG);

  useEffect(() => {
    const i1 = new Image();
    i1.src = OPEN_BG;
    const i2 = new Image();
    i2.src = CLOSED_BG;

    const update = () => setBgUrl(isMarketOpenET() ? OPEN_BG : CLOSED_BG);
    update();
    const id = setInterval(update, 30_000);
    const onVis = () => document.visibilityState === "visible" && update();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Stocks & AI analysis
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<string>("");
  const [recommendation, setRecommendation] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [topPicks, setTopPicks] = useState<string[]>([]);

  // Modal (TradingView)
  const [selectedStock, setSelectedStock] = useState<string | null>(null);
  const [chartVisible, setChartVisible] = useState(false);
  const [agentResult, setAgentResult] = useState<string | null>(null);

  // Bot / trades
  const [botData, setBotData] = useState<any>(null);
  const [tradeData, setTradeData] = useState<TradePayload | null>(null);
  const { tick: statusTick, tradesToday: statusTradesToday, error: statusError } = useBotPoll(5000);

  // Alpaca account (for PnL pill)
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
      } catch {
        // ignore parse errors
      }
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
      } catch {
        // ignore
      }
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
      } catch {
        // ignore
      }
    };
    run();
    id = setInterval(run, 5000);
    return () => clearInterval(id);
  }, []);

  // Poll Alpaca account (for live day PnL)
  useEffect(() => {
    let id: any;
    const run = async () => {
      try {
        const r = await fetch("/api/alpaca/account", { cache: "no-store" });
        const j = await r.json();
        if (j?.ok && j?.account) setAlpaca(j.account as AlpacaAccount);
      } catch {
        // ignore
      }
    };
    run();
    id = setInterval(run, 10_000);
    return () => clearInterval(id);
  }, []);

  // Ask AI recs — use only top 8 from (already filtered) stream list
  const askAIRecommendation = async () => {
    try {
      setAnalyzing(true);
      setRecommendation(null);
      const res = await fetch("/api/recommendation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stocks: stocks.slice(0, 8), topN: 2 }),
      });
      const data = await res.json();

      if (!res.ok || data?.errorMessage) {
        setRecommendation(`Error: ${data?.errorMessage || res.statusText}`);
        setTopPicks([]);
        return;
      }

      const picks: string[] = Array.isArray(data?.picks) ? data.picks : [];
      const reasons: Record<string, string[]> = data?.reasons || {};
      const risk: string = data?.risk || "";

      setTopPicks(picks.slice(0, 2).map((t) => String(t).toUpperCase()));

      const lines: string[] = [];
      if (picks[0]) {
        lines.push(`Top 1: ${picks[0]}`);
        if (Array.isArray(reasons[picks[0]]) && reasons[picks[0]].length)
          lines.push(`  • ${reasons[picks[0]].join("\n  • ")}`);
      }
      if (picks[1]) {
        lines.push("");
        lines.push(`Top 2: ${picks[1]}`);
        if (Array.isArray(reasons[picks[1]]) && reasons[picks[1]].length)
          lines.push(`  • ${reasons[picks[1]].join("\n  • ")}`);
      }
      if (risk) {
        lines.push("");
        lines.push(`Risk: ${risk}`);
      }
      setRecommendation(lines.join("\n") || "No recommendation.");
    } catch {
      setRecommendation("Failed to analyze stocks. Check server logs.");
      setTopPicks([]);
    } finally {
      setAnalyzing(false);
    }
  };

  /* ===========================
     Chart behaviors (DECOUPLED)
  =========================== */
  const handleStockClick = (ticker: string) => {
    setSelectedStock(ticker);
    setChartVisible(true);
    setAgentResult(null);
  };
  const closeChart = () => {
    setChartVisible(false);
    setSelectedStock(null);
    setAgentResult(null);
  };

  const posChartSymbol = useMemo(
    () => (tradeData?.openPos?.ticker ? String(tradeData.openPos.ticker).toUpperCase() : undefined),
    [tradeData?.openPos?.ticker]
  );

  // before-close fallback symbol (prefer open position, else first gainer)
  const [beforeCloseET, setBeforeCloseET] = useState<boolean>(() => {
    const d = nowET();
    const mins = d.getHours() * 60 + d.getMinutes();
    return mins <= 16 * 60; // 4:00pm ET
  });
  useEffect(() => {
    const id = setInterval(() => {
      const d = nowET();
      const mins = d.getHours() * 60 + d.getMinutes();
      setBeforeCloseET(mins <= 16 * 60);
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const fallbackSymbolBeforeClose =
    beforeCloseET
      ? (posChartSymbol || (stocks[0]?.ticker && String(stocks[0].ticker).toUpperCase()) || "AAPL")
      : undefined;

  const todayTradeCount = useMemo(() => {
    const fromStatus = Array.isArray(statusTradesToday) ? statusTradesToday.length : null;
    if (fromStatus != null) return fromStatus;
    const all = tradeData?.trades || [];
    if (!all.length) return 0;
    const todayKey = ymdET(new Date());
    let n = 0;
    for (const t of all) {
      const ms =
        pickMs(t.createdAt) ??
        pickMs(t.time) ??
        pickMs(t.ts) ??
        pickMs(t.at) ??
        pickMs(t.filledAt) ??
        pickMs(t.executedAt);
      if (!ms) continue;
      if (ymdET(new Date(ms)) === todayKey) n++;
    }
    return n;
  }, [statusTradesToday, tradeData]);

  const dayPnl = alpaca?.day_pnl ?? botData?.state?.pnl ?? null;

  return (
    <main
      className="min-h-screen w-full flex flex-col"
      style={{
        backgroundImage: `url(${bgUrl})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        backgroundAttachment: "fixed",
        transition: "background-image 300ms ease-in-out",
      }}
    >
      <Navbar />

      <div className="flex-1 px-4 pt-20 pb-6">
        <div className="mb-10 md:mb-14">
          <FloatingNarrator />
        </div>

        <div className="grid gap-5 xl:grid-cols-[460px_minmax(720px,1fr)_960px] lg:grid-cols-1">
          {/* LEFT: AI Chat */}
          <div>
            <GlassPanel title="AI Chat" color="cyan" dense>
              <ChatBox />
            </GlassPanel>
          </div>

          {/* MIDDLE: Top Gainers + Trade Log (replacing Level 2) */}
          <div className="grid gap-5">
            <TopGainers
              loading={loading}
              errorMessage={errorMessage}
              stocks={stocks}
              dataSource={dataSource}
              onAskAI={askAIRecommendation}
              analyzing={analyzing}
              onPick={handleStockClick}
            />

            {/* Trade Log replaces Level 2 here at same height */}
            <TradeLog tradeData={tradeData} height={225} />
          </div>

          {/* RIGHT: Positions chart + status cards */}
          <div className="grid gap-5">
            <div className="relative">
              <TradeChartPanel height={720} symbolWhenFlat={fallbackSymbolBeforeClose} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-stretch">
              <AIRecommendation
                botData={botData}
                alpaca={alpaca}
                analyzing={analyzing}
                askAI={askAIRecommendation}
                stocksCount={stocks.length}
                recommendation={recommendation}
              />
              <BotStatus statusError={statusError} statusTick={statusTick} todayTradeCount={todayTradeCount} />
            </div>
          </div>
        </div>
      </div>

      {/* TradingView modal */}
      {chartVisible && selectedStock && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeChart();
          }}
        >
          <div className="w-full max-w-6xl bg-white rounded-2xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <div className="font-semibold text-slate-800">{selectedStock} — TradingView</div>
              <button
                onClick={closeChart}
                className="rounded-md px-3 py-1.5 text-sm font-medium bg-slate-900 text-white hover:bg-slate-800"
              >
                Close
              </button>
            </div>
            <div className="h-[680px]">
              <TradingViewChart key={selectedStock} symbol={selectedStock} height={680} />
            </div>
            <div className="px-4 py-3 border-t bg-slate-50 flex items-center gap-3">
              <Button className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-sm rounded-md">
                Analyze This Chart
              </Button>
              {agentResult && (
                <pre className="text-xs whitespace-pre-wrap bg-white rounded-md p-2 ring-1 ring-slate-200 flex-1 overflow-auto max-h-40">
                  {agentResult}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/* =========================================================
   Chat + TopGainers + TradeLog + AIRecommendation + BotStatus
========================================================= */

function ChatBox() {
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
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
    <div className="flex flex-col">
      <div
        ref={scrollRef}
        className="
          overflow-y-auto rounded-3xl p-4 md:p-5 space-y-3
          bg-white/45 backdrop-blur-2xl ring-1 ring-white/50
          shadow-[0_20px_60px_rgba(0,0,0,0.20)]
        "
        style={{ height: CHAT_FIXED_HEIGHT_PX }}
      >
        {!messages.length && (
          <div className="text-[14px] md:text-[15px] leading-relaxed text-slate-900">
            Ask me things like:
            <br />• What did you trade today?
            <br />• Did you make money today?
            <br />• Are you in a position?
            <br />• What ticker did you trade today?
          </div>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            className={[
              "max-w-[85%] whitespace-pre-wrap px-4 py-2.5 text-[14px] md:text-[15px] rounded-2xl shadow-sm transition",
              m.role === "user"
                ? "ml-auto bg-blue-600 text-white ring-1 ring-white/40"
                : "bg-white text-slate-900 ring-1 ring-gray-200",
            ].join(" ")}
          >
            {m.content}
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <div className="flex-1 flex items-center gap-2 rounded-2xl pl-4 pr-3 bg-white/95 ring-1 ring-gray-300">
          <input
            className="flex-1 bg-transparent placeholder-gray-500 text-slate-900 px-0 py-3 text-[15px] md:text-base outline-none"
            placeholder="Type your question…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            disabled={busy}
          />
        </div>
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          className="rounded-xl bg-blue-600 text-white px-5 py-3 text-[15px] font-semibold shadow hover:bg-blue-700 disabled:opacity-60"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function TopGainers({
  loading,
  errorMessage,
  stocks,
  dataSource,
  onAskAI,
  analyzing,
  onPick,
}: {
  loading: boolean;
  errorMessage: string | null;
  stocks: Stock[];
  dataSource: string;
  onAskAI: () => void;
  analyzing: boolean;
  onPick: (ticker: string) => void;
}) {
  const HEADERS = ["Symbol", "Price", "Change %", "Market Cap", "Float", "Volume", "Avg Vol", "Employees"];

  return (
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
            onClick={onAskAI}
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
                  className="group cursor-pointer transition"
                  onClick={() => onPick(stock.ticker)}
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
  );
}

function TradeLog({
  tradeData,
  slim = false,
  height,
}: {
  tradeData: TradePayload | null;
  slim?: boolean;
  height?: number;
}) {
  const wrapperClass = slim ? "overflow-auto" : "h-full overflow-auto";
  const style = height ? { height } : undefined;

  return (
    <Panel title="Trade Log" color="orange" dense>
      {!tradeData?.trades?.length ? (
        <p className="text-gray-500 text-sm">No trades yet.</p>
      ) : (
        <div className={wrapperClass} style={style}>
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
  );
}

function AIRecommendation({
  botData,
  alpaca,
  analyzing,
  askAI,
  stocksCount,
  recommendation,
}: {
  botData: any;
  alpaca: AlpacaAccount | null;
  analyzing: boolean;
  askAI: () => void;
  stocksCount: number;
  recommendation: string | null;
}) {
  return (
    <Panel title="AI Recommendation" color="blue" dense>
      {botData?.lastRec ? (
        <div className="mb-3 text-sm border border-gray-200 rounded p-2 bg-gray-50">
          <div>
            <b>AI Pick:</b> {botData.lastRec.ticker}
          </div>
          <div>
            <b>Price:</b>{" "}
            {typeof botData.lastRec.price === "number" ? `$${Number(botData.lastRec.price).toFixed(2)}` : "—"}
          </div>
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

      {(alpaca || botData?.state) && (
        <div className="mb-3 text-sm border border-gray-200 rounded p-2">
          {(() => {
            const money = alpaca?.cash ?? botData?.state?.cash ?? null;
            const eq = alpaca?.equity ?? botData?.state?.equity ?? null;
            const dayPnl = alpaca?.day_pnl ?? botData?.state?.pnl ?? null;

            return (
              <>
                <div>
                  Money I Have: <b>{money != null ? `$${Number(money).toFixed(2)}` : "—"}</b>{" "}
                  {alpaca && <span className="text-xs text-gray-500">(Alpaca)</span>}
                </div>
                <div>
                  Equity: <b>{eq != null ? `$${Number(eq).toFixed(2)}` : "—"}</b>{" "}
                  {alpaca && <span className="text-xs text-gray-500">(Alpaca)</span>}
                </div>
                <div>
                  PNL:{" "}
                  <b className={Number(dayPnl ?? 0) >= 0 ? "text-green-600" : "text-red-600"}>
                    {dayPnl != null ? `${Number(dayPnl) >= 0 ? "+" : "-"}$${Math.abs(Number(dayPnl)).toFixed(2)}` : "—"}
                  </b>{" "}
                  {alpaca && <span className="text-xs text-gray-500">(Today, Alpaca)</span>}
                </div>
                {alpaca?.day_pnl_pct != null && (
                  <div className="text-xs text-gray-600">Day PnL %: {(alpaca.day_pnl_pct * 100).toFixed(2)}%</div>
                )}
              </>
            );
          })()}
        </div>
      )}

      <Button
        onClick={askAI}
        disabled={analyzing || stocksCount === 0}
        className="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 transition disabled:opacity-60 disabled:cursor-not-allowed"
        title={stocksCount === 0 ? "No stocks loaded yet" : "Send list to AI (Top 1 & Top 2)"}
      >
        {analyzing ? "Analyzing..." : "Ask AI"}
      </Button>

      {recommendation && (
        <div className="mt-3 text-sm whitespace-pre-wrap max-h-48 overflow-y-auto pr-2">{recommendation}</div>
      )}

      <div className="mt-2 text-xs text-gray-500">
        Server ET:{" "}
        {botData?.serverTimeET
          ? new Date(botData.serverTimeET).toLocaleTimeString("en-US", { timeZone: "America/New_York" })
          : "…"}
      </div>
    </Panel>
  );
}

function BotStatus({
  statusError,
  statusTick,
  todayTradeCount,
}: {
  statusError: string | null | undefined;
  statusTick: any;
  todayTradeCount: number;
}) {
  return (
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
  );
}
