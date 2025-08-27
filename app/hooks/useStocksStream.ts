import { useEffect, useState } from "react";

export type Stock = {
  ticker: string;
  price: number | null;
  changesPercentage: number | null;
  marketCap: number | null;
  sharesOutstanding: number | null;
  volume: number | null;
  avgVolume?: number | null;
  employees?: number | null;
};

export function useStocksStream() {
  const [data, setData] = useState<{ stocks: Stock[]; updatedAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/stocks/stream");
      es.onmessage = (evt) => {
        try {
          const obj = JSON.parse(evt.data);
          setData({ stocks: obj.stocks ?? [], updatedAt: obj.updatedAt });
        } catch {}
      };
      es.onerror = () => setError("stream error");
    } catch (e: any) {
      setError(e?.message || "failed to connect");
    }
    return () => es?.close();
  }, []);

  return { data, error };
}
