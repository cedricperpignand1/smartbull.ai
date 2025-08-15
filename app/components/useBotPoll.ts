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
  serverTimeET?: string;
  info?: { inEntryWindow?: boolean; snapshotAgeMs?: number } | any;
  signals?: any;
  debug?: { lastMessage?: string; reasons?: string[] } | any;

  /** Present when the bot short-circuited (e.g., market closed) */
  skipped?: "not_weekday" | "market_closed" | "no_snapshot" | "stale_snapshot";
};

export type Trade = {
  id: number;
  side: "BUY" | "SELL";
  ticker: string;
  price: number;
  shares: number;
  createdAt?: string;
};

type TradesPayload = { trades: Trade[] } | any;

/* ===========================
   Hook
=========================== */

/**
 * Polls /api/bot/tick and /api/trades on a timer.
 * - Pauses when the tab is hidden; resumes when visible.
 * - No overlapping requests (single-flight).
 * - Backoff on errors (up to ~30s), then recovers.
 *
 * NOTE: We deliberately do NOT fetch /api/stocks here (you use SSE for that).
 */
export function useBotPoll(intervalMs = 5000) {
  const [tick, setTick] = useState<TickPayload | null>(null);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const inFlightRef = useRef(false);
  const backoffRef = useRef<number | null>(null);
  const abortTickRef = useRef<AbortController | null>(null);
  const abortTradesRef = useRef<AbortController | null>(null);

  // schedule next run with optional backoff
  const schedule = (delay: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(runOnce, delay);
  };

  const runOnce = async () => {
    // Don’t run when page is hidden; try again later
    if (document.hidden) {
      schedule(intervalMs);
      return;
    }

    if (inFlightRef.current) return; // single-flight
    inFlightRef.current = true;

    // cancel any slow previous calls
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
      setTrades(Array.isArray((tr as any)?.trades) ? (tr as any).trades : Array.isArray(tr) ? (tr as any) : null);
      setError(null);

      // success: clear backoff and schedule normal interval
      backoffRef.current = null;
      schedule(intervalMs);
    } catch (e: any) {
      if (e?.name === "AbortError") {
        // aborted due to visibility change or new run; just bail
        return;
      }
      const msg = e?.message || "Network error";
      setError(msg);

      // incremental backoff up to ~30s
      const prev = backoffRef.current ?? intervalMs * 2;
      const next = Math.min(prev * 1.5, 30_000);
      backoffRef.current = next;
      schedule(next);
    } finally {
      inFlightRef.current = false;
    }
  };

  useEffect(() => {
    // kick off immediately if visible
    if (!document.hidden) runOnce();
    else schedule(intervalMs);

    // pause/resume when tab visibility changes
    const onVis = () => {
      if (document.hidden) {
        // stop timers and cancel in-flight
        if (timerRef.current) clearTimeout(timerRef.current);
        if (abortTickRef.current) abortTickRef.current.abort();
        if (abortTradesRef.current) abortTradesRef.current.abort();
      } else {
        // resume quickly on return
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

  return { tick, trades, error };
}
