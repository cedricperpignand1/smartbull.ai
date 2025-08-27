"use client";

import { useMemo } from "react";
import { useBotPoll } from "@/app/components/useBotPoll";

export default function BotStatusCard() {
  const { tick, tradesToday, error } = useBotPoll(5000);

  // ----- Status banner (color + text) -----
  const status = useMemo(() => {
    const msg = (tick?.debug as any)?.lastMessage as string | undefined;

    let cls = "bg-gray-50 text-gray-800 border border-gray-200";
    if (msg) {
      const m = msg.toLowerCase();
      if (m.startsWith("🚀") || m.startsWith("🏁") || m.includes("bought")) {
        cls = "bg-green-50 text-green-800 border border-green-200";
      } else if (m.startsWith("⛔") || m.includes("error") || m.includes("stale")) {
        cls = "bg-red-50 text-red-800 border border-red-200";
      } else if (m.startsWith("🛑") || m.startsWith("⏳") || m.startsWith("🔁") || m.startsWith("📈")) {
        cls = "bg-amber-50 text-amber-800 border border-amber-200";
      }
    }

    return {
      msg: msg ?? "Waiting for next update…",
      cls,
      snapshotAgeMs: tick?.info?.snapshotAgeMs as number | undefined,
      inWindow: tick?.info?.inEntryWindow as boolean | undefined,
    };
  }, [tick]);

  // ----- Friendly strings -----
  const friendlyRec =
    tick?.lastRec
      ? `Pick: ${tick.lastRec.ticker} @ ${
          typeof tick.lastRec.price === "number" ? `$${tick.lastRec.price.toFixed(2)}` : "—"
        }`
      : "No recommendation yet — bot is waiting for a valid pick.";

  const friendlyPos =
    tick?.position
      ? `Open: ${tick.position.ticker} x${tick.position.shares} @ $${Number(
          tick.position.entryPrice
        ).toFixed(2)}`
      : "No open position — bot will enter only if conditions are met during the entry window.";

  const friendlyTrades =
    Array.isArray(tradesToday) && tradesToday.length
      ? `${tradesToday.length} trade${tradesToday.length === 1 ? "" : "s"} today (ET).`
      : "No trades executed yet today.";

  const top8 = ((tick as any)?.debug?.top8 as string[] | undefined) ?? [];
  const friendlyWatchlist =
    top8.length > 0
      ? `${top8.length} symbols in top-8: ${top8.join(", ")}`
      : "Snapshot/top-8 not available yet.";

  return (
    <div className="rounded-xl border p-4 bg-white">
      <h3 className="font-semibold mb-3">SmartBull Bot Status</h3>

      {error && <p className="text-red-600 text-sm mb-2">Error: {error}</p>}

      {/* Status banner */}
      <div className={`rounded-lg px-3 py-2 text-sm mb-3 ${status.cls}`}>
        <div className="whitespace-pre-wrap break-words">{status.msg}</div>
        <div className="mt-1 text-xs opacity-70 space-x-3">
          {typeof status.snapshotAgeMs === "number" && (
            <span>Snapshot age: {Math.round(status.snapshotAgeMs)} ms</span>
          )}
          {typeof status.inWindow === "boolean" && (
            <span>Entry window: {status.inWindow ? "OPEN" : "CLOSED"}</span>
          )}
        </div>
      </div>

      {/* Live / Server time */}
      <div className="text-sm bg-gray-50 border rounded px-3 py-2 mb-3">
        <div>
          <span className="text-gray-600">Live:</span>{" "}
          {tick?.live?.ticker ? `${tick.live.ticker} @ ${tick.live.price ?? "—"}` : "—"}
        </div>
        <div className="text-gray-600">
          Server (ET):{" "}
          {tick?.serverTimeET
            ? new Date(tick.serverTimeET).toLocaleTimeString("en-US", {
                timeZone: "America/New_York",
              })
            : "—"}
        </div>
      </div>

      {/* Last Recommendation */}
      <div className="mt-3 text-sm">
        <div className="font-medium mb-1">Last Recommendation</div>
        <div className="text-xs bg-gray-50 p-2 rounded min-h-[40px]">{friendlyRec}</div>
      </div>

      {/* Open Position */}
      <div className="mt-3 text-sm">
        <div className="font-medium mb-1">Open Position</div>
        <div className="text-xs bg-gray-50 p-2 rounded min-h-[40px]">{friendlyPos}</div>
      </div>

      {/* Recent Trades */}
      <div className="mt-3 text-sm">
        <div className="font-medium mb-1">Recent Trades</div>
        <div className="text-xs bg-gray-50 p-2 rounded min-h-[40px]">{friendlyTrades}</div>
      </div>

      {/* Watchlist from snapshot (server-provided top-8) */}
      <div className="mt-3 text-sm">
        <div className="font-medium mb-1">Watchlist (from snapshot)</div>
        <div className="text-xs bg-gray-50 p-2 rounded min-h-[40px]">{friendlyWatchlist}</div>
      </div>
    </div>
  );
}
