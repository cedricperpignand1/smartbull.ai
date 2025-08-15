"use client";

import { useEffect, useState } from "react";

type Stock = {
  ticker: string;
  price: number | null;
  changesPercentage: number | null;
};

export default function StocksLive() {
  const [data, setData] = useState<{ stocks: Stock[]; updatedAt: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/stocks/stream");

    es.onmessage = (evt) => {
      try {
        const obj = JSON.parse(evt.data);
        setData({ stocks: obj.stocks ?? [], updatedAt: obj.updatedAt });
      } catch (e) {
        // ignore parse errors
      }
    };

    es.onerror = () => setErr("stream error");
    return () => es.close();
  }, []);

  if (err) return <div className="text-red-600">{err}</div>;
  if (!data) return <div>Loading live stocks…</div>;

  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-500">
        Updated: {new Date(data.updatedAt).toLocaleTimeString()}
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-[420px] text-sm">
          <thead className="text-xs text-gray-500">
            <tr>
              <th className="text-left pr-4">Ticker</th>
              <th className="text-right pr-4">Price</th>
              <th className="text-right">Change %</th>
            </tr>
          </thead>
          <tbody>
            {data.stocks.slice(0, 8).map((s) => (
              <tr key={s.ticker}>
                <td className="font-mono pr-4">{s.ticker}</td>
                <td className="text-right pr-4">{s.price ?? "—"}</td>
                <td className="text-right">{s.changesPercentage ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
