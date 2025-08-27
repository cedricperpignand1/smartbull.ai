"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/** ===== Types ===== */
type Trade = {
  id: string;
  ts: number; // epoch ms
  ticker: string;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
};

type TradeWithPnL = Trade & { realized?: number; cum?: number };

type Position = {
  ticker: string;
  qty: number;
  avgCost: number;
  lastPrice?: number;
  unrealized?: number;
};

const LS_KEY = "tradeLog_allTime_v2_fifo";

/** ===== NEW: table window (7 days) ===== */
const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** ===== Helpers ===== */
function parseTs(input: any): number | null {
  if (input == null) return null;
  if (typeof input === "number") {
    // accept seconds or ms
    return input < 1e12 ? Math.round(input * 1000) : Math.round(input);
  }
  const t = new Date(input).getTime();
  return Number.isFinite(t) ? t : null;
}

function normalizeRows(input: any): Trade[] {
  const arr = Array.isArray(input) ? input : [];
  return arr
    .map((t: any) => {
      const ts =
        parseTs(t.ts) ??
        parseTs(t.time) ??
        parseTs(t.createdAt) ??
        Date.now();

      const ticker = String(t.ticker ?? t.symbol ?? "").toUpperCase();
      const side: "BUY" | "SELL" =
        String(t.side ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY";
      const price = Number(t.price ?? t.fillPrice ?? 0);
      const qty = Number(t.qty ?? t.shares ?? 0);
      const rawId = t.id ?? `${ts}-${ticker}-${side}-${price}-${qty}`;

      return { id: String(rawId), ts, ticker, side, price, qty };
    })
    .filter((t) => t.ticker && t.price > 0 && t.qty !== 0 && Number.isFinite(t.ts))
    .sort((a, b) => a.ts - b.ts);
}

function mergeTrades(existing: Trade[], incoming: Trade[]): Trade[] {
  const map = new Map<string, Trade>();
  for (const t of existing) map.set(t.id, t);
  for (const t of incoming) map.set(t.id, t);
  return Array.from(map.values()).sort((a, b) => a.ts - b.ts);
}

function saveToLS(trades: Trade[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(trades));
  } catch {}
}
function loadFromLS(): Trade[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return normalizeRows(parsed);
  } catch {
    return [];
  }
}

/** ===== FIFO P&L ===== */
type Lot = { qty: number; cost: number };

function applyFIFO(inv: Map<string, Lot[]>, trade: Trade): number {
  const lots = inv.get(trade.ticker) ?? [];
  const isBuy = trade.side === "BUY";
  const flow = isBuy ? trade.qty : -trade.qty;
  let realized = 0;

  const totalPos = lots.reduce((s, l) => s + l.qty, 0);

  if (totalPos !== 0 && Math.sign(totalPos) !== Math.sign(flow)) {
    let remaining = Math.abs(flow);
    while (remaining > 0 && lots.length) {
      const lot = lots[0];
      const available = Math.min(Math.abs(lot.qty), remaining);

      if (lot.qty > 0 && !isBuy) {
        realized += (trade.price - lot.cost) * available;
        lot.qty -= available;
      } else if (lot.qty < 0 && isBuy) {
        realized += (lot.cost - trade.price) * available;
        lot.qty += available;
      }
      remaining -= available;
      if (lot.qty === 0) lots.shift();
    }
    if (remaining > 0) {
      lots.push({ qty: Math.sign(flow) * remaining, cost: trade.price });
    }
  } else {
    lots.push({ qty: flow, cost: trade.price });
  }

  inv.set(trade.ticker, lots);
  return realized;
}

function computePnLandPositions(tradesAsc: Trade[]): {
  annotated: TradeWithPnL[];
  positions: Position[];
} {
  const inv: Map<string, Lot[]> = new Map();
  let cum = 0;
  const annotated: TradeWithPnL[] = [];

  for (const t of tradesAsc) {
    const realized = applyFIFO(inv, t);
    cum += realized;
    annotated.push({ ...t, realized, cum });
  }

  const positions: Position[] = [];
  for (const [ticker, lots] of inv.entries()) {
    if (!lots.length) continue;
    const qty = lots.reduce((sum, l) => sum + l.qty, 0);
    if (qty === 0) continue;
    const totalCost = lots.reduce((sum, l) => sum + l.cost * l.qty, 0);
    positions.push({ ticker, qty, avgCost: totalCost / qty });
  }

  return { annotated, positions };
}

function fmtET(ms?: number) {
  if (!Number.isFinite(ms as number)) return "—";
  const d = new Date(ms!);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", { timeZone: "America/New_York" });
}

/** ===== Component ===== */
export default function TradeLogPanel() {
  const [history, setHistory] = useState<Trade[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [showReset, setShowReset] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load from localStorage (migrated via normalize)
  useEffect(() => {
    setHistory(loadFromLS());
  }, []);

  // Poll server: /api/trades (object with {trades, openPos}); fallback to /api/bot/trades if needed
  useEffect(() => {
    const fetchTrades = async () => {
      try {
        let res = await fetch("/api/trades?days=7&limit=2000", { cache: "no-store" });

        if (!res.ok) {
          res = await fetch("/api/bot/trades?limit=200", { cache: "no-store" });
        }
        if (!res.ok) throw new Error();
        const data = await res.json();

        // The API returns an object -> feed only the array to normalizer
        const serverRows = Array.isArray(data) ? data : (data?.trades ?? []);
        const incoming = normalizeRows(serverRows);

        setHistory((prev) => {
          const merged = mergeTrades(prev, incoming);
          saveToLS(merged);
          return merged;
        });
      } catch {
        /* ignore network hiccups */
      }
    };

    fetchTrades();
    pollRef.current = setInterval(fetchTrades, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // PnL + positions (computed across FULL history to keep FIFO accurate)
  const { annotated, positions: computedPos } = useMemo(
    () => computePnLandPositions(history),
    [history]
  );

  // ===== NEW: table rows filtered to the last 7 days =====
  const rows = useMemo(() => {
    const cutoff = Date.now() - WINDOW_MS;
    return annotated.filter((t) => t.ts >= cutoff).slice().reverse();
  }, [annotated]);

  // Fetch last prices for unrealized P&L (based on FULL computed positions)
  useEffect(() => {
    const loadPrices = async () => {
      if (computedPos.length === 0) {
        setPositions([]);
        return;
      }
      const tickers = computedPos.map((p) => p.ticker).join(",");
      const res = await fetch(
        `https://financialmodelingprep.com/api/v3/quote/${tickers}?apikey=M0MLRDp8dLak6yJOfdv7joKaKGSje8pp`
      );
      const data = await res.json();
      setPositions(
        computedPos.map((pos) => {
          const quote = data.find((q: any) => q.symbol === pos.ticker);
          if (quote) {
            const unrealized = (quote.price - pos.avgCost) * pos.qty;
            return { ...pos, lastPrice: quote.price, unrealized };
          }
          return pos;
        })
      );
    };
    loadPrices();
  }, [computedPos]);

  /** ===== Reset flow (uses /api/bot/reset expecting { key }) ===== */
  const openReset = () => {
    setMsg(null);
    setPassword("");
    setShowReset(true);
  };
  const closeReset = () => {
    if (!busy) setShowReset(false);
  };
  const confirmReset = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/bot/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: password }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setMsg("Incorrect password or reset failed.");
      } else {
        try {
          localStorage.removeItem(LS_KEY);
        } catch {}
        setHistory([]);
        setPositions([]);
        setMsg("✅ Reset complete.");
        setTimeout(() => {
          setShowReset(false);
          window.location.reload();
        }, 600);
      }
    } catch {
      setMsg("Reset error. Check server logs.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4">
      {/* POSITIONS */}
      <h2 className="font-bold text-lg mb-2">Open Positions</h2>
      {positions.length === 0 ? (
        <p className="text-gray-500">No open positions.</p>
      ) : (
        <table className="min-w-full text-sm border mb-6">
          <thead className="bg-gray-200">
            <tr>
              <th className="p-2 border">Ticker</th>
              <th className="p-2 border">Qty</th>
              <th className="p-2 border">Avg Cost</th>
              <th className="p-2 border">Last Price</th>
              <th className="p-2 border">Unrealized P&L</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.ticker} className="hover:bg-gray-50">
                <td className="p-2 border">{p.ticker}</td>
                <td className="p-2 border">{p.qty}</td>
                <td className="p-2 border">${p.avgCost.toFixed(2)}</td>
                <td className="p-2 border">
                  {p.lastPrice ? `$${p.lastPrice.toFixed(2)}` : "—"}
                </td>
                <td
                  className={`p-2 border ${
                    (p.unrealized ?? 0) >= 0 ? "text-green-600" : "text-red-600"
                  }`}
                >
                  {p.unrealized !== undefined
                    ? `${p.unrealized >= 0 ? "+" : "-"}$${Math.abs(
                        p.unrealized
                      ).toFixed(2)}`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* TRADE LOG + RESET BUTTON */}
      <div className="relative">
        <button
          onClick={openReset}
          className="absolute top-2 right-3 z-50 rounded-lg px-3 py-1.5 text-sm font-medium bg-rose-600 text-white hover:bg-rose-700 active:scale-[.99] shadow"
          title="Reset trades/positions/recs (admin)"
        >
          Reset (admin)
        </button>

        <h2 className="font-bold text-lg mb-2 pr-28">
          Trade Log (last {WINDOW_DAYS} days)
        </h2>

        {rows.length === 0 ? (
          <p className="text-gray-500">No trades in the last {WINDOW_DAYS} days.</p>
        ) : (
          <table className="min-w-full text-sm border">
            <thead className="bg-slate-900 text-white">
              <tr>
                <th className="p-2 border border-slate-800/60">Time (ET)</th>
                <th className="p-2 border border-slate-800/60">Side</th>
                <th className="p-2 border border-slate-800/60">Ticker</th>
                <th className="p-2 border border-slate-800/60">Price</th>
                <th className="p-2 border border-slate-800/60">Shares</th>
                <th className="p-2 border border-slate-800/60">Realized</th>
                <th className="p-2 border border-slate-800/60">Cumulative</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="odd:bg-white even:bg-slate-50">
                  <td className="p-2 border">{fmtET(t.ts)}</td>
                  <td className="p-2 border">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ${
                        t.side === "BUY"
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {t.side}
                    </span>
                  </td>
                  <td className="p-2 border">{t.ticker}</td>
                  <td className="p-2 border">${t.price.toFixed(2)}</td>
                  <td className="p-2 border">{t.qty}</td>
                  <td
                    className={`p-2 border ${
                      (t.realized ?? 0) >= 0 ? "text-green-600" : "text-red-600"
                    }`}
                  >
                    {t.realized !== undefined
                      ? `${t.realized >= 0 ? "+" : "-"}$${Math.abs(
                          t.realized
                        ).toFixed(2)}`
                      : "—"}
                  </td>
                  <td
                    className={`p-2 border ${
                      (t.cum ?? 0) >= 0 ? "text-green-600" : "text-red-600"
                    }`}
                  >
                    {t.cum !== undefined
                      ? `${t.cum >= 0 ? "+" : "-"}$${Math.abs(t.cum).toFixed(2)}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* PASSWORD MODAL */}
      {showReset && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeReset();
          }}
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <div className="text-lg font-semibold text-slate-800">
              Confirm Reset
            </div>
            <p className="mt-1 text-sm text-slate-600">
              This wipes all trades, positions, and AI picks, and resets the bot balance.
            </p>

            <label className="block mt-4 text-sm text-slate-700">Password</label>
            <input
              type="password"
              autoFocus
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-rose-500"
              placeholder="Enter password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && password) confirmReset();
                if (e.key === "Escape") closeReset();
              }}
            />

            {msg && <div className="mt-3 text-sm">{msg}</div>}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                disabled={busy}
                onClick={closeReset}
                className="rounded-xl px-3 py-1.5 text-sm font-medium border border-slate-300 text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                disabled={busy || password.length === 0}
                onClick={confirmReset}
                className="rounded-xl px-3 py-1.5 text-sm font-medium bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-60"
              >
                {busy ? "Resetting…" : "Confirm Reset"}
              </button>
            </div>

            <div className="mt-3 text-xs text-slate-500">
              Hint: password is <span className="font-semibold">Fuck OFF</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
