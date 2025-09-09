"use client";

import { useEffect, useMemo, useState } from "react";

export type BookRow = { price: number; size: number; sizeNotional: number };

type HookArgs = {
  symbol: string;
  mock?: boolean;
};

export function useOrderBookL2({ symbol, mock = true }: HookArgs) {
  const [bids, setBids] = useState<BookRow[]>([]);
  const [asks, setAsks] = useState<BookRow[]>([]);
  const [ts, setTs] = useState<number | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchOnce() {
    setLoading(true);
    setError(null);
    try {
      const url = mock
        ? `/api/level2?symbol=${encodeURIComponent(symbol)}&mock=1`
        : `/api/level2?symbol=${encodeURIComponent(symbol)}`;
      const res = await fetch(url, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);

      const _b: BookRow[] = (j.bids || []).map((x: any) => ({
        price: Number(x.price),
        size: Number(x.size),
        sizeNotional: Number(x.price) * Number(x.size),
      }));
      const _a: BookRow[] = (j.asks || []).map((x: any) => ({
        price: Number(x.price),
        size: Number(x.size),
        sizeNotional: Number(x.price) * Number(x.size),
      }));

      setBids(_b);
      setAsks(_a);
      setTs(Date.now());
    } catch (e: any) {
      setError(e?.message || "failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!symbol) return;
    fetchOnce();
    const id = setInterval(fetchOnce, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, mock]);

  const stats = useMemo(() => {
    const bidNotional = bids.reduce((s, r) => s + r.sizeNotional, 0);
    const askNotional = asks.reduce((s, r) => s + r.sizeNotional, 0);
    const bidCount = bids.reduce((s, r) => s + r.size, 0);
    const askCount = asks.reduce((s, r) => s + r.size, 0);
    const imbalance =
      (bidNotional - askNotional) / Math.max(1, bidNotional + askNotional);
    return { bidNotional, askNotional, bidCount, askCount, imbalance };
  }, [bids, asks]);

  return { bids, asks, ts, loading, error, stats };
}
