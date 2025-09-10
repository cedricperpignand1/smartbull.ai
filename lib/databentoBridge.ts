// lib/databentoBridge.ts

import WebSocket from "ws";
import { upsertBook } from "./l2Store";
import type { L2Level } from "./l2Store";
import { getActiveSymbols } from "./l2Tracker";

export type UnsubFn = () => void;

const DB_WS_URL = process.env.DATABENTO_API_URL || "wss://live.databento.com/v0";
const DB_KEY    = process.env.DATABENTO_API_KEY || "";
// IMPORTANT: set to a dataset you’re licensed for (e.g., stocks.sip or a venue dataset)
const DB_DATASET = process.env.DATABENTO_DATASET || "stocks.sip";

/* ── Step A: simple debug switch (logs first N frames) ── */
const L2_DEBUG = (process.env.L2_DEBUG ?? "false").toLowerCase() === "true";
let debugFramesLeft = 20;

let currentSubs: Record<string, UnsubFn> = {};

/* Feed MBP-10 updates into the store */
export function onMbp10(symbol: string, bidsRaw: Array<[number, number]>, asksRaw: Array<[number, number]>) {
  const bids: L2Level[] = (bidsRaw || []).map(([px, sz]) => ({ px: Number(px), sz: Number(sz) }));
  const asks: L2Level[] = (asksRaw || []).map(([px, sz]) => ({ px: Number(px), sz: Number(sz) }));
  if (!bids.length || !asks.length) return;
  upsertBook(symbol.toUpperCase(), bids, asks);
}

/* Defensive parser for various MBP-10 shapes (tweak once you see frames) */
function parseMbp10Frame(frame: any): { bids: Array<[number, number]>; asks: Array<[number, number]> } | null {
  const bidsRaw = (frame?.bids ?? frame?.bid ?? frame?.levels?.bids ?? frame?.book?.bids ?? []).slice(0, 10);
  const asksRaw = (frame?.asks ?? frame?.ask ?? frame?.levels?.asks ?? frame?.book?.asks ?? []).slice(0, 10);
  if (!Array.isArray(bidsRaw) || !Array.isArray(asksRaw)) return null;

  const toPair = (l: any) => {
    const px = Number(l?.p ?? l?.price ?? l?.px ?? (Array.isArray(l) ? l[0] : NaN));
    const sz = Number(l?.s ?? l?.size  ?? l?.sz ?? (Array.isArray(l) ? l[1] : NaN));
    return [px, sz] as [number, number];
  };

  const bids = bidsRaw.map(toPair).filter(([px, sz]) => Number.isFinite(px) && Number.isFinite(sz));
  const asks = asksRaw.map(toPair).filter(([px, sz]) => Number.isFinite(px) && Number.isFinite(sz));
  if (!bids.length || !asks.length) return null;

  bids.sort((a, b) => b[0] - a[0]); // best bid first
  asks.sort((a, b) => a[0] - b[0]); // best ask first

  /* ── Step A: debug log a few frames ── */
  if (L2_DEBUG && debugFramesLeft > 0) {
    debugFramesLeft--;
    // keep it compact—just show best levels + counts
    console.log("[L2][frame]", {
      bestBid: bids[0],
      bestAsk: asks[0],
      bidCount: bids.length,
      askCount: asks.length,
    });
  }

  return { bids, asks };
}

/* SUBSCRIBE: Databento WebSocket (one WS per symbol for simplicity) */
async function subscribeOne(symbol: string): Promise<UnsubFn> {
  if (!DB_KEY) {
    console.warn("[L2] Missing DATABENTO_API_KEY; skipping subscribe:", symbol);
    return () => {};
  }

  // Query-string auth + subscription params.
  const qs = new URLSearchParams({
    key: DB_KEY,
    dataset: DB_DATASET,
    schema: "mbp-10",
    symbols: symbol,
    // encoding: "jsonl" // uncomment if your feed requires explicit JSONL
  }).toString();

  const url = `${DB_WS_URL}?${qs}`;
  const ws = new WebSocket(url);

  let buffer = ""; // accumulate NDJSON chunks

  ws.on("open", () => {
    console.log(`[L2] ws open → ${symbol} (${DB_DATASET} mbp-10)`);
  });

  ws.on("message", (data: WebSocket.RawData) => {
    try {
      const chunk = typeof data === "string" ? data : data.toString("utf8");
      buffer += chunk;

      // Split into lines for NDJSON; keep the final partial line in buffer
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || "";

      for (const line of parts) {
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line);
          const parsed = parseMbp10Frame(frame);
          if (parsed) onMbp10(symbol, parsed.bids, parsed.asks);
        } catch {
          // ignore malformed/heartbeat lines
        }
      }
    } catch {
      // swallow parse errors to keep stream alive
    }
  });

  ws.on("error", (err: any) => {
    console.error(`[L2] ws error (${symbol}):`, err?.message || err);
  });

  ws.on("close", (code: number, reason: Buffer) => {
    console.log(`[L2] ws closed → ${symbol} (${code}) ${reason?.toString?.() || ""}`);
  });

  // keep-alive ping
  const pingTimer = setInterval(() => {
    try { if (ws.readyState === WebSocket.OPEN) ws.ping(); } catch {}
  }, 15000);

  // Unsubscribe/cleanup
  return () => {
    try { clearInterval(pingTimer); } catch {}
    try { ws.removeAllListeners(); } catch {}
    try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch {}
  };
}

/* Keep active subscriptions (max 2) in sync with /api/l2/track */
export async function reconcileSubscriptions() {
  const wanted = new Set(getActiveSymbols().symbols.map(s => s.toUpperCase()));

  // Unsubscribe unwanted
  for (const sym of Object.keys(currentSubs)) {
    if (!wanted.has(sym)) {
      try { currentSubs[sym]!(); } catch {}
      delete currentSubs[sym];
      console.log("[L2] unsubscribed", sym);
    }
  }

  // Subscribe new
  for (const sym of wanted) {
    if (!currentSubs[sym]) {
      currentSubs[sym] = await subscribeOne(sym);
      console.log("[L2] subscribed", sym);
    }
  }
}

/* Optional background loop (safe to call multiple times) */
let timer: NodeJS.Timeout | null = null;
export function startL2SubscriptionLoop(intervalMs = 1500) {
  if (timer) return;
  timer = setInterval(() => { reconcileSubscriptions().catch(() => {}); }, intervalMs);
}
export function stopL2SubscriptionLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}
