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
  ratio: number;
  marketOpen: boolean;
  tickers?: string[];
  session?: { dateET: string; startISO: string; endISO: string };
};

export default function Navbar() {
  const router = useRouter();

  const [time, setTime] = useState<string>("");
  const [rows, setRows] = useState<TickerRow[]>([]);
  const [winnerLabel, setWinnerLabel] = useState<string | null>(null);
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
      } catch (e) {
        console.error("SSE parse error:", e);
      }
    };
    es.onerror = () => {};
    return () => es.close();
  }, []);

  // Top sets from your stream
  const top13 = useMemo(
    () => rows.slice(0, 13).map((r) => r.ticker).filter(Boolean),
    [rows]
  );
  const top8 = useMemo(
    () => top13.slice(0, 8).map((t) => t.toUpperCase()),
    [top13]
  );

  /* Winner industry every 10 minutes (and once immediately) */
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
        if (!r.ok) {
          const text = await r.text();
          console.error("industry-winner HTTP error:", r.status, text);
          return;
        }
        const j = await r.json();
        if (!stop && j?.ok && j?.winner?.label) {
          setWinnerLabel(String(j.winner.label));
        }
      } catch (e) {
        console.error("industry-winner fetch error:", e);
      }
    };

    fetchWinner();
    const id = setInterval(fetchWinner, 10 * 60 * 1000);
    return () => {
      stop = true;
      ac?.abort();
      clearInterval(id);
    };
  }, [top13.join(",")]);

  /* VWAP breadth every 60s (and once immediately) */
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

        if (!r.ok) {
          const text = await r.text();
          console.error("VWAP breadth HTTP error:", r.status, text);
          return;
        }

        const j: VwapBreadth = await r.json();
        console.log("VWAP breadth:", j);
        if (!stop && j?.ok) {
          setVwapBreadth(j);
        }
      } catch (e) {
        console.error("VWAP breadth fetch error:", e);
      }
    };

    fetchBreadth();
    const id = setInterval(fetchBreadth, 60 * 1000);
    return () => {
      stop = true;
      ac?.abort();
      clearInterval(id);
    };
  }, [top8.join(",")]);

  // VWAP breadth badge (always show something)
  const vwapBadge = useMemo(() => {
    if (!vwapBreadth) {
      return (
        <div
          className="ml-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold shadow-sm ring-1 bg-slate-50 text-slate-700 ring-slate-200"
          title="Fetching VWAP breadth…"
        >
          <span className="tracking-wide">VWAP</span>
          <span className="font-mono">…</span>
        </div>
      );
    }

    const { marketOpen, total, above } = vwapBreadth;

    if (!marketOpen) {
      return (
        <div
          className="ml-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold shadow-sm ring-1 bg-slate-50 text-slate-700 ring-slate-200"
          title="Market closed — VWAP breadth paused"
        >
          <span className="tracking-wide">VWAP</span>
          <span className="font-mono">⏸</span>
        </div>
      );
    }

    if (!total) {
      return (
        <div
          className="ml-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold shadow-sm ring-1 bg-slate-50 text-slate-700 ring-slate-200"
          title="No VWAP data yet"
        >
          <span className="tracking-wide">VWAP</span>
          <span className="font-mono">—</span>
        </div>
      );
    }

    const ratio = above / total;
    let bg = "bg-slate-50";
    let text = "text-slate-700";
    let ring = "ring-slate-200";
    let arrow = "↔";

    if (ratio >= 5 / 8) {
      bg = "bg-emerald-50";
      text = "text-emerald-700";
      ring = "ring-emerald-200";
      arrow = "↑";
    } else if (ratio <= 3 / 8) {
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

          {/* CENTER: Industry sticker + VWAP breadth */}
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
