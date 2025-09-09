// app/components/useOrderBook.ts
"use client";

import { useEffect, useMemo, useState } from "react";

export type OrderBookLevel = { px: number; sz: number };
export type OrderBookSnapshot = {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  bestBid: number;
  bestAsk: number;
  mid: number;
  spreadBps: number;
  ts: number;
};

type Opts = { symbol: string; depth?: number; mock?: boolean };

export function useOrderBook({ symbol, depth = 10, mock = false }: Opts) {
  const [snap, setSnap] = useState<OrderBookSnapshot | null>(null);

  useEffect(() => {
    let stop: (() => void) | null = null;

    if (!mock) {
      const es = new EventSource(`/api/l2/stream?symbol=${encodeURIComponent(symbol)}`);
      es.onmessage = (e) => {
        try {
          const obj = JSON.parse(e.data);
          obj.bids = (obj.bids || []).slice(0, depth);
          obj.asks = (obj.asks || []).slice(0, depth);
          setSnap(obj);
        } catch {}
      };
      es.onerror = () => { /* SSE auto-retries */ };
      stop = () => es.close();
    } else {
      const iv = setInterval(() => {
        const mid = 10 + Math.random() * 2;
        const spread = 0.01;
        const bestBid = +(mid - spread / 2).toFixed(4);
        const bestAsk = +(mid + spread / 2).toFixed(4);
        const mk = (inc: number, base: number) =>
          Array.from({ length: depth }, (_, i) => ({ px: +(base + i * inc).toFixed(4), sz: Math.floor(100 + Math.random() * 300) }));
        setSnap({
          bids: mk(-0.01, bestBid),
          asks: mk(+0.01, bestAsk),
          bestBid, bestAsk, mid, spreadBps: ((bestAsk - bestBid) / mid) * 10000, ts: Date.now()
        });
      }, 400);
      stop = () => clearInterval(iv);
    }

    return () => { stop?.(); };
  }, [symbol, depth, mock]);

  const metrics = useMemo(() => {
    if (!snap) return null;
    const bidSum = snap.bids.reduce((a, b) => a + b.sz, 0);
    const askSum = snap.asks.reduce((a, b) => a + b.sz, 0);
    const imbalance = (bidSum - askSum) / Math.max(1, bidSum + askSum);
    return { bidSum, askSum, imbalance };
  }, [snap]);

  return { snap, metrics };
}
