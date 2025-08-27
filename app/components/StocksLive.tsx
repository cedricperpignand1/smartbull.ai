// /app/components/StocksLive.tsx
"use client";
import { useEffect, useState } from "react";

type Stock = { ticker: string; price: number|null; changesPercentage: number|null; };

export default function StocksLive() {
  const [data, setData] = useState<{ stocks: Stock[]; updatedAt: string } | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/stocks/stream");
    es.onmessage = (evt) => { try { setData(JSON.parse(evt.data)); } catch {} };
    return () => es.close();
  }, []);

  if (!data) return <div>Loading live stocks…</div>;

  return (
    <div>
      <div className="text-xs text-gray-500">Updated: {new Date(data.updatedAt).toLocaleTimeString()}</div>
      <ul className="text-sm">
        {data.stocks.slice(0, 8).map(s => (
          <li key={s.ticker}>
            <span className="font-mono">{s.ticker}</span> ${s.price ?? "—"} ({s.changesPercentage ?? "—"}%)
          </li>
        ))}
      </ul>
    </div>
  );
}
