"use client";

import { useEffect, useRef, useState } from "react";
import { getJSON } from "@/lib/getJSON";

/* ===========================
   Types
=========================== */

export type TickPayload = {
  state?: { cash: number; pnl: number; equity: number } | any;
  lastRec?: { ticker: string; price: number; at?: string } | any;
  position?: { ticker: string; entryPrice: number; shares: number } | any;
  live?: { ticker: string | null; price: number | null } | null;
  serverTimeET?: string; // used as the canonical “now” in ET
  info?: { inEntryWindow?: boolean; snapshotAgeMs?: number } | any;
  signals?: any;
  debug?: { lastMessage?: string; reasons?: string[]; top8?: string[] } | any;
  skipped?: "not_weekday" | "market_closed" | "no_snapshot" | "stale_snapshot";
};

export type Trade = {
  id: number;
  side: "BUY" | "SELL";
  ticker: string;
  price: number;
  shares: number;

  // Possible timestamp fields (your API may use any of these)
  createdAt?: string | number;
  filledAt?: string | number;
  openedAt?: string | number;
  submittedAt?: string | number;
  executedAt?: string | number;
  timestamp?: string | number;
  time?: string | number;

  // Some backends also include a pre-computed day key:
  ymdET?: string; // "YYYY-MM-DD" in ET
};

type TradesPayload = { trades: Trade[] } | any;

/* ===========================
   Helpers
=========================== */

// Format a Date as America/New_York YYYY-MM-DD
function etYmd(d: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find(p => p.type === "year")!.value;
  const m = parts.find(p => p.type === "month")!.value;
  const day = parts.find(p => p.type === "day")!.value;
  return `${y}-${m}-${day}`;
}

// Turn many possible timestamp shapes into a Date (null if nothing usable)
function toDate(x: string | number | undefined): Date | null {
  if (x == null) return null;
  if (typeof x === "number") return new Date(x); // epoch ms
  const d = new Date(x);
  return isNaN(d.getTime()) ? null : d;
}

// Get the best ET day key for a trade
function tradeETKey(t: Trade): string | null {
  // If backend already sent an ET day key, trust it.
  if (typeof t.ymdET === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.ymdET)) return t.ymdET;

  const cand =
    toDate(t.createdAt) ||
    toDate(t.filledAt) ||
    toDate(t.openedAt) ||
    toDate(t.submittedAt) ||
    toDate(t.executedAt) ||
    toDate(t.timestamp) ||
    toDate(t.time);

  return cand ? etYmd(cand) : null;
}

let printedOnce = false;

/* ===========================
   Hook
=========================== */

/**
 * Polls /api/bot/tick and /api/trades.
 * Returns:
 *  - tick (latest bot status)
 *  - trades (all returned by API)
 *  - tradesToday (subset whose ET day matches server ET today)
 */
export function useBotPoll(intervalMs = 5000) {
  const [tick, setTick] = useState<TickPayload | null>(null);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [tradesToday, setTradesToday] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const inFlightRef = useRef(false);
  const backoffRef = useRef<number | null>(null);
  const abortTickRef = useRef<AbortController | null>(null);
  const abortTradesRef = useRef<AbortController | null>(null);

  const schedule = (delay: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(runOnce, delay);
  };

  const runOnce = async () => {
    if (document.hidden) {
      schedule(intervalMs);
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    if (abortTickRef.current) abortTickRef.current.abort();
    if (abortTradesRef.current) abortTradesRef.current.abort();
    abortTickRef.current = new AbortController();
    abortTradesRef.current = new AbortController();

    try {
      const [t, tr] = await Promise.all([
        getJSON<TickPayload>("/api/bot/tick", { signal: abortTickRef.current.signal } as any),
        getJSON<TradesPayload>("/api/trades", { signal: abortTradesRef.current.signal } as any),
      ]);

      setTick(t || null);

      const all: Trade[] | null = Array.isArray((tr as any)?.trades)
        ? ((tr as any).trades as Trade[])
        : Array.isArray(tr)
        ? (tr as Trade[])
        : null;

      setTrades(all);

      // Use the server's ET clock for "today" (fallback: client now)
      const nowETKey = etYmd(t?.serverTimeET ? new Date(t.serverTimeET) : new Date());

      // Build ET day keys for each trade and filter
      const todayList =
        all?.filter(trd => {
          const k = tradeETKey(trd);
          return k ? k === nowETKey : false;
        }) ?? null;

      setTradesToday(todayList);

      // One-time debug so you can verify what dates your API is returning
      if (all && !printedOnce) {
        const counts = all.reduce<Record<string, number>>((acc, trd) => {
          const k = tradeETKey(trd) ?? "UNKNOWN";
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {});
        // eslint-disable-next-line no-console
        console.info("[useBotPoll] Trade date buckets (ET):", counts, "today=", nowETKey);
        printedOnce = true;
      }

      setError(null);
      backoffRef.current = null;
      schedule(intervalMs);
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setError(e?.message || "Network error");
      const prev = backoffRef.current ?? intervalMs * 2;
      const next = Math.min(prev * 1.5, 30_000);
      backoffRef.current = next;
      schedule(next);
    } finally {
      inFlightRef.current = false;
    }
  };

  useEffect(() => {
    if (!document.hidden) runOnce();
    else schedule(intervalMs);

    const onVis = () => {
      if (document.hidden) {
        if (timerRef.current) clearTimeout(timerRef.current);
        if (abortTickRef.current) abortTickRef.current.abort();
        if (abortTradesRef.current) abortTradesRef.current.abort();
      } else {
        backoffRef.current = null;
        runOnce();
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortTickRef.current) abortTickRef.current.abort();
      if (abortTradesRef.current) abortTradesRef.current.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  return { tick, trades, tradesToday, error };
}
