"use client";

import { useEffect, useState } from "react";
import Navbar from "../components/Navbar";

type PnlRow = {
  id: number;
  positionId: number;
  ticker: string;
  entryPrice: string;
  exitPrice: string;
  shares: number;
  invested: string;
  realized: string;
  openedAt: string;
  closedAt: string;
};

export default function PnlPage() {
  const [rows, setRows] = useState<PnlRow[]>([]);
  const [totals, setTotals] = useState<{ invested: number; realized: number }>({
    invested: 0,
    realized: 0,
  });
  const [paused, setPaused] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setError(null);
      const [pnlRes, pauseRes] = await Promise.all([
        fetch("/api/pnl", { cache: "no-store" }),
        fetch("/api/bot/pause", { cache: "no-store" }),
      ]);
      if (!pnlRes.ok) throw new Error("Failed to load P&L");
      if (!pauseRes.ok) throw new Error("Failed to load pause state");

      const pnl = await pnlRes.json();
      const pause = await pauseRes.json();
      setRows(pnl.rows || []);
      setTotals(pnl.totals || { invested: 0, realized: 0 });
      setPaused(!!pause.paused);
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 5000); // refresh every 5s
    return () => clearInterval(id);
  }, []);

  const togglePause = async (val: boolean) => {
    try {
      setError(null);
      const r = await fetch("/api/bot/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: val }),
      });
      if (!r.ok) throw new Error("Failed to update pause state");
      const j = await r.json();
      setPaused(!!j.paused);
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Failed to update pause state");
    }
  };

  return (
    <main>
      <Navbar />
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">P&amp;L (Live)</h1>
          <div className="flex gap-3">
            <button
              onClick={() => togglePause(false)}
              className={`px-4 py-2 rounded text-white ${
                paused ? "bg-green-600 hover:bg-green-700" : "bg-gray-500"
              }`}
              disabled={!paused}
              title="Resume the bot"
            >
              ▶ Run
            </button>
            <button
              onClick={() => togglePause(true)}
              className={`px-4 py-2 rounded text-white ${
                paused ? "bg-red-700" : "bg-red-600 hover:bg-red-700"
              }`}
              disabled={paused}
              title="Pause the bot"
            >
              ⏸ Pause
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded border border-red-300 bg-red-50 text-red-700 px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <div className="overflow-x-auto rounded-xl shadow-lg border border-gray-200">
          <table className="min-w-full border-collapse">
            <thead className="bg-gray-100 sticky top-0 z-10">
              <tr>
                {[
                  "Closed (ET)",
                  "Ticker",
                  "Shares",
                  "Entry",
                  "Exit",
                  "Invested",
                  "P/L",
                  "Opened (ET)",
                  "PositionId",
                ].map((h) => (
                  <th
                    key={h}
                    className="p-3 text-left text-sm font-semibold text-gray-700 border-b border-gray-200"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td className="p-4 text-gray-500" colSpan={9}>
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td className="p-4 text-gray-500" colSpan={9}>
                    No trades yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const inv = Number(r.invested);
                  const rlz = Number(r.realized);
                  return (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="p-3">
                        {new Date(r.closedAt).toLocaleString("en-US", {
                          timeZone: "America/New_York",
                        })}
                      </td>
                      <td className="p-3 font-semibold">{r.ticker}</td>
                      <td className="p-3">{r.shares}</td>
                      <td className="p-3">${Number(r.entryPrice).toFixed(2)}</td>
                      <td className="p-3">${Number(r.exitPrice).toFixed(2)}</td>
                      <td className="p-3">${inv.toFixed(2)}</td>
                      <td
                        className={`p-3 font-semibold ${
                          rlz >= 0 ? "text-green-600" : "text-red-600"
                        }`}
                      >
                        {rlz >= 0 ? "+" : ""}
                        ${rlz.toFixed(2)}
                      </td>
                      <td className="p-3">
                        {new Date(r.openedAt).toLocaleString("en-US", {
                          timeZone: "America/New_York",
                        })}
                      </td>
                      <td className="p-3 text-xs text-gray-500">{r.positionId}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between mt-6">
          <div className="text-sm text-gray-600">
            Bot is:{" "}
            <b className={paused ? "text-red-700" : "text-green-700"}>
              {paused ? "PAUSED" : "RUNNING"}
            </b>
          </div>
          <div
            className={`text-xl font-bold ${
              totals.realized >= 0 ? "text-green-600" : "text-red-600"
            }`}
          >
            Total Realized: {totals.realized >= 0 ? "+" : ""}$
            {totals.realized.toFixed(2)}
          </div>
        </div>
      </div>
    </main>
  );
}
