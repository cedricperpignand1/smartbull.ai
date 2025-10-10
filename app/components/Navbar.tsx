// components/Navbar.tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { signOut } from "next-auth/react";
import IndustryHypeSticker, { TickerRow as BaseTickerRow } from "./IndustryHypeSticker";

/* Extend the row locally to keep IndustryHypeSticker untouched */
type TickerRow = BaseTickerRow & {
  volume?: number | null;       // from SSE (may be missing)
  price?: number | null;        // from SSE
  volEstimate?: number | null;  // computed as dollarVolume/price when volume missing
};

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

        const mapped: TickerRow[] = list.map((s: any) => {
          const price = s?.price != null ? Number(s.price) : null;
          const volume = s?.volume != null ? Number(s.volume) : null;

          // Prefer provided dollarVolume; else compute from price*volume if both exist
          const dollarVolume =
            s?.dollarVolume != null
              ? Number(s.dollarVolume)
              : price != null && volume != null
              ? price * volume
              : null;

          // Estimate cumulative volume if raw volume missing
          const volEstimate =
            volume != null
              ? volume
              : dollarVolume != null && price != null && price > 0
              ? Math.round(dollarVolume / price)
              : null;

          return {
            ticker: String(s.ticker || s.symbol || ""),
            changesPercentage:
              typeof s.changesPercentage === "number"
                ? s.changesPercentage
                : null,
            dollarVolume,
            sector: s?.sector ?? null,
            industry: s?.industry ?? null,
            volume,
            price,
            volEstimate,
          };
        });

        setRows(mapped);
      } catch (e) {
        console.error("SSE parse error:", e);
      }
    };
    es.onerror = () => {};
    return () => es.close();
  }, []);

  // Top lists from stream
  const top13 = useMemo(() => rows.slice(0, 13), [rows]);

  // Filter: only names with cumulative volume (est) >= 9M
  const top13Eligible = useMemo(
    () =>
      top13.filter((r) => {
        const v = r.volEstimate ?? r.volume ?? 0;
        return v >= 9_000_000;
      }),
    [top13]
  );

  // Debug which got included/excluded
  useEffect(() => {
    if (!top13.length) return;
    try {
      console.table(
        top13.map((r) => ({
          ticker: r.ticker,
          price: r.price,
          volume: r.volume,
          dollarVolume: r.dollarVolume,
          volEstimate: r.volEstimate,
          included: (r.volEstimate ?? r.volume ?? 0) >= 9_000_000,
        }))
      );
    } catch {}
  }, [
    top13.map((r) => r.ticker).join(","),
    top13.map((r) => r.volEstimate ?? r.volume ?? 0).join(","),
  ]);

  const eligibleTickers = useMemo(
    () => top13Eligible.map((r) => r.ticker.toUpperCase()),
    [top13Eligible]
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
          body: JSON.stringify({ tickers: top13.map((r) => r.ticker) }),
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
  }, [top13.map((r) => r.ticker).join(",")]);

  /* VWAP breadth every 60s (and once immediately) — only eligible tickers */
  useEffect(() => {
    if (!eligibleTickers.length) {
      // Neutral when nothing qualifies
      setVwapBreadth({
        ok: true,
        total: 0,
        above: 0,
        below: 0,
        flat: 0,
        ratio: 0,
        marketOpen: true,
        tickers: [],
      });
      return;
    }

    let stop = false;
    let ac: AbortController | null = null;

    const fetchBreadth = async () => {
      try {
        ac = new AbortController();
        const r = await fetch("/api/vwap-breadth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tickers: eligibleTickers }),
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
        if (!stop && j?.ok) setVwapBreadth(j);
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
  }, [eligibleTickers.join(",")]);

  // Always show a badge
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
          title="No VWAP data yet or all < 9M vol"
        >
          <span className="tracking-wide">VWAP</span>
          <span className="font-mono">—</span>
        </div>
      );
    }

    const ratio = above / total;
    let bg = "bg-slate-50",
      text = "text-slate-700",
      ring = "ring-slate-200",
      arrow = "↔";

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
        title="VWAP breadth across high-volume names"
      >
        <span className="tracking-wide">VWAP</span>
        <span className="font-mono">
          {arrow} {above}/{total}
        </span>
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
