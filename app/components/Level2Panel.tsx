"use client";
import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  symbol: string;
  height?: number;
  /** show a fake order book if true */
  mock?: boolean;
};

type Row = { price: number; size: number };

export default function Level2Panel({ symbol, height = 360, mock = true }: Props) {
  const [bids, setBids] = useState<Row[]>([]);
  const [asks, setAsks] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- simple fake data generator so the panel is never empty
  const seedRef = useRef(0);
  useEffect(() => {
    if (!mock) {
      setBids([]);
      setAsks([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const mid = 50 + (symbol.charCodeAt(0) % 40); // just a stable-ish midpoint per symbol
    const mk = () => Math.max(0.01, mid + (Math.random() - 0.5) * 0.6);
    const genSide = (dir: "bid" | "ask"): Row[] => {
      const rows: Row[] = [];
      let p = mk();
      for (let i = 0; i < 12; i++) {
        p += dir === "bid" ? -Math.random() * 0.12 : Math.random() * 0.12;
        rows.push({ price: Number(p.toFixed(2)), size: Math.floor(50 + Math.random() * 900) });
      }
      // sort: bids descending, asks ascending
      return rows.sort((a, b) => (dir === "bid" ? b.price - a.price : a.price - b.price));
    };

    const tick = () => {
      seedRef.current++;
      setBids(genSide("bid"));
      setAsks(genSide("ask"));
      setLoading(false);
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => clearInterval(id);
  }, [symbol, mock]);

  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const spread = useMemo(
    () => (bestBid != null && bestAsk != null ? (bestAsk - bestBid).toFixed(2) : "—"),
    [bestBid, bestAsk]
  );

  return (
    <div className="h-full flex flex-col bg-white rounded-2xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-2.5 flex items-center justify-between border-b border-gray-200">
        <div className="font-semibold text-slate-800">
          Level 2 — <span className="font-mono">{symbol.toUpperCase()}</span>
        </div>
        <div className="text-xs text-slate-600">
          {loading ? "loading…" : error ? <span className="text-red-600">{error}</span> : `Spread: ${spread}`}
        </div>
      </div>

      {/* Table layout */}
      <div className="grid grid-cols-2 gap-0" style={{ height }}>
        {/* BIDS */}
        <div className="border-r border-gray-200 overflow-auto">
          <div className="sticky top-0 bg-emerald-600 text-white text-xs px-3 py-1.5">Bids</div>
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-slate-500">
                <th className="text-left px-3 py-1">Price</th>
                <th className="text-right px-3 py-1">Size</th>
              </tr>
            </thead>
            <tbody>
              {bids.map((r, i) => (
                <tr key={`b-${i}`} className="odd:bg-emerald-50">
                  <td className="px-3 py-1 font-mono">${r.price.toFixed(2)}</td>
                  <td className="px-3 py-1 text-right font-mono">{r.size.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!mock && (
            <div className="p-3 text-xs text-slate-500">
              Live feed not wired yet — using empty state.
            </div>
          )}
        </div>

        {/* ASKS */}
        <div className="overflow-auto">
          <div className="sticky top-0 bg-rose-600 text-white text-xs px-3 py-1.5">Asks</div>
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-slate-500">
                <th className="text-left px-3 py-1">Price</th>
                <th className="text-right px-3 py-1">Size</th>
              </tr>
            </thead>
            <tbody>
              {asks.map((r, i) => (
                <tr key={`a-${i}`} className="odd:bg-rose-50">
                  <td className="px-3 py-1 font-mono">${r.price.toFixed(2)}</td>
                  <td className="px-3 py-1 text-right font-mono">{r.size.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!mock && (
            <div className="p-3 text-xs text-slate-500">
              Live feed not wired yet — using empty state.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
