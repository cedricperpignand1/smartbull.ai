// components/Navbar.tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { signOut } from "next-auth/react";
import IndustryHypeSticker, { TickerRow } from "./IndustryHypeSticker";

export default function Navbar() {
  const router = useRouter();

  const [time, setTime] = useState<string>("");
  const [rows, setRows] = useState<TickerRow[]>([]);
  const [winnerLabel, setWinnerLabel] = useState<string | null>(null);

  /* Clock */
  useEffect(() => {
    const tick = () =>
      setTime(new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  /* Live stocks via SSE */
  useEffect(() => {
    const es = new EventSource("/api/stocks/stream");
    es.onmessage = (evt) => {
      try {
        const obj = JSON.parse(evt.data);
        const list = Array.isArray(obj?.stocks) ? obj.stocks : [];
        const mapped: TickerRow[] = list.map((s: any) => ({
          ticker: String(s.ticker || s.symbol || ""),
          changesPercentage: typeof s.changesPercentage === "number" ? s.changesPercentage : null,
          dollarVolume:
            s?.dollarVolume != null
              ? Number(s.dollarVolume)
              : ((Number(s.price) || 0) * (Number(s.volume) || 0)) || null,
          sector: s?.sector ?? null,
          industry: s?.industry ?? null,
        }));
        setRows(mapped);
      } catch {}
    };
    es.onerror = () => {};
    return () => es.close();
  }, []);

  // Pick top 13 tickers (by current ordering from your stream)
  const top13 = useMemo(() => rows.slice(0, 13).map(r => r.ticker).filter(Boolean), [rows]);

  /* Poll winner industry every 10 minutes (and once immediately when we have data) */
  useEffect(() => {
    if (!top13.length) return;

    let stop = false;
    let ac: AbortController | null = null;

    const fetchWinner = async () => {
      try {
        ac = new AbortController();
        const r = await fetch("/api/industry-winner", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tickers: top13 }),
          cache: "no-store",
          signal: ac.signal,
        });
        const j = await r.json();
        if (!stop && j?.ok && j?.winner?.label) {
          setWinnerLabel(String(j.winner.label));
        }
      } catch {}
    };

    fetchWinner();
    const id = setInterval(fetchWinner, 10 * 60 * 1000); // 10 minutes

    return () => { stop = true; ac?.abort(); clearInterval(id); };
  }, [top13.join(",")]); // re-run if the top-13 set changes

  return (
    <header className="sticky top-0 z-50 w-full">
      <div className="h-16 w-full bg-white/20 backdrop-blur-lg border-b border-white/30 shadow-sm">
        <div className="mx-auto max-w-screen-2xl h-full px-4 flex items-center">
          {/* LEFT: Logo */}
          <div className="flex items-center gap-3">
            <button onClick={() => router.push("/")} className="flex items-center gap-3 hover:opacity-95" aria-label="Go to Home">
              <Image src="/logo4.png" alt="SmartBull Logo" width={100} height={100} className="h-15 w-15 object-contain" priority />
              <span className="text-white drop-shadow text-xl md:text-2xl font-extrabold tracking-tight">
                <span className="text-white/90">Smart</span>
                <span className="text-white">Bull.ai</span>
              </span>
            </button>
          </div>

          {/* CENTER: Sticker — color by SPY tone, text by winner industry */}
          <div className="flex-1 flex justify-center">
            {rows.length ? (
              <IndustryHypeSticker
                rows={rows}
                groupBy="industry"
                minNames={1}
                overrideLabel={winnerLabel || undefined}   // <= winner from FMP enrichment
              />
            ) : (
              <div className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs shadow-sm bg-slate-50 text-slate-700 border-slate-200">
                <span className="font-semibold tracking-wide">Loading…</span>
              </div>
            )}
          </div>

          {/* RIGHT: Time + Sign Out */}
          <div className="flex items-center gap-4">
            <span className="hidden sm:inline-flex items-center rounded-md px-3 py-1.5 text-sm md:text-base font-medium font-mono bg-white/25 ring-1 ring-white/35 text-white">
              {time || "--:--:--"}
            </span>
            <button
              onClick={() => signOut({ callbackUrl: "/" })}
              className="inline-flex items-center rounded-md px-4 py-2 text-base font-semibold bg-white text-blue-700 hover:bg-gray-50 shadow-sm transition"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
