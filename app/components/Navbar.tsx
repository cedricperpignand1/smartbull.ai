// components/Navbar.tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { signOut } from "next-auth/react";
import IndustryHypeSticker, { TickerRow } from "./IndustryHypeSticker";

type VwapBreadth = {
  ok: boolean;
  total: number;
  above: number;
  below: number;
  flat: number;
  ratio: number; // above / total
  marketOpen: boolean;
};

export default function Navbar() {
  const router = useRouter();

  const [time, setTime] = useState<string>("");
  const [rows, setRows] = useState<TickerRow[]>([]);
  const [winnerLabel, setWinnerLabel] = useState<string | null>(null);

  // NEW: VWAP breadth state
  const [vwapBreadth, setVwapBreadth] = useState<VwapBreadth | null>(null);

  /* Clock */
  useEffect(() => {
    const tick = () =>
      setTime(
        new Date().toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      );
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
          changesPercentage:
            typeof s.changesPercentage === "number" ? s.changesPercentage : null,
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
  const top13 = useMemo(
    () => rows.slice(0, 13).map((r) => r.ticker).filter(Boolean),
    [rows]
  );

  // NEW: Select top 8 for VWAP breadth
  const top8 = useMemo(
    () => top13.slice(0, 8).map((t) => t.toUpperCase()),
    [top13]
  );

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

    return () => {
      stop = true;
      ac?.abort();
      clearInterval(id);
    };
  }, [top13.join(",")]); // re-run if the top-13 set changes

  /* NEW: Poll VWAP breadth every 60s (and on top8 change) */
  useEffect(() => {
    if (!top8.length) return;

    let stop = false;
    let ac: AbortController | null = null;

    const fetchBreadth = async () => {
      try {
        ac = new AbortController();
        const r = await fetch("/api/vwap-breadth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tickers: top8 }),
          cache: "no-store",
          signal: ac.signal,
        });
        const j: VwapBreadth = await r.json();
        if (!stop && j?.ok) {
          setVwapBreadth(j);
        }
      } catch {}
    };

    fetchBreadth();
    const id = setInterval(fetchBreadth, 60 * 1000); // 60 seconds

    return () => {
      stop = true;
      ac?.abort();
      clearInterval(id);
    };
  }, [top8.join(",")]);

  // NEW: badge style based on ratio
  const vwapBadge = useMemo(() => {
    if (!vwapBreadth || !vwapBreadth.total) return null;
    const { above, total, ratio } = vwapBreadth;

    let bg = "bg-slate-50";
    let text = "text-slate-700";
    let ring = "ring-slate-200";
    let arrow = "↔";

    if (ratio >= 5 / 8) {
      // risk-on
      bg = "bg-emerald-50";
      text = "text-emerald-700";
      ring = "ring-emerald-200";
      arrow = "↑";
    } else if (ratio <= 3 / 8) {
      // risk-off
      bg = "bg-rose-50";
      text = "text-rose-700";
      ring = "ring-rose-200";
      arrow = "↓";
    }

    return (
      <div
        className={`ml-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold shadow-sm ring-1 ${bg} ${text} ${ring}`}
        title="VWAP breadth across top 8 (above-VWAP count)"
      >
        <span className="tracking-wide">VWAP</span>
        <span className="font-mono">{arrow} {above}/{total}</span>
      </div>
    );
  }, [vwapBreadth]);

  return (
    <header className="sticky top-0 z-50 w-full">
      <div className="h-16 w-full bg-white/20 backdrop-blur-lg border-b border-white/30 shadow-sm">
        <div className="mx-auto max-w-screen-2xl h-full px-4 flex items-center">
          {/* LEFT: Logo */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push("/")}
              className="flex items-center gap-3 hover:opacity-95"
              aria-label="Go to Home"
            >
              <Image
                src="/logo4.png"
                alt="SmartBull Logo"
                width={100}
                height={100}
                className="h-15 w-15 object-contain"
                priority
              />
              <span className="text-white drop-shadow text-xl md:text-2xl font-extrabold tracking-tight">
                <span className="text-white/90">Smart</span>
                <span className="text-white">Bull.ai</span>
              </span>
            </button>
          </div>

          {/* CENTER: Sticker — color by SPY tone, text by winner industry + VWAP breadth */}
          <div className="flex-1 flex justify-center">
            {rows.length ? (
              <div className="flex items-center">
                <IndustryHypeSticker
                  rows={rows}
                  groupBy="industry"
                  minNames={1}
                  overrideLabel={winnerLabel || undefined}
                />
                {vwapBadge}
              </div>
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
