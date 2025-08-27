"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { signOut } from "next-auth/react";
import TradeNarrator from "./TradeNarrator"; // ⬅️ make sure path is correct

type BotTick = {
  lastRec?: { ticker: string; price?: number; at?: string } | null;
  position?: { ticker: string; entryPrice: number; shares: number } | null;
  live?: { ticker: string | null; price?: number | null } | null;
  serverTimeET?: string;
};

export default function Navbar() {
  const router = useRouter();
  const [time, setTime] = useState<string>("");
  const [narratorOpen, setNarratorOpen] = useState(false);
  const [botTick, setBotTick] = useState<BotTick | null>(null);

  const popRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  // --- Clock ---
  useEffect(() => {
    const t = setInterval(() => {
      setTime(
        new Date().toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      );
    }, 1000);
    setTime(
      new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    );
    return () => clearInterval(t);
  }, []);

  // --- Poll bot tick only when dropdown is open ---
  useEffect(() => {
    if (!narratorOpen) return;

    let cancelled = false;
    let id: number | null = null;

    const run = async () => {
      try {
        const r = await fetch("/api/bot/tick", { cache: "no-store" });
        const j = await r.json();
        if (!cancelled) setBotTick(j);
      } catch {
        /* ignore */
      }
    };

    run();
    id = window.setInterval(run, 10_000);
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
    };
  }, [narratorOpen]);

  // --- Close dropdown on outside click / ESC ---
  useEffect(() => {
    if (!narratorOpen) return;

    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setNarratorOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNarratorOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [narratorOpen]);

  // --- Build narrator input from botTick ---
  const narratorSymbol =
    botTick?.position?.ticker ??
    botTick?.lastRec?.ticker ??
    "TBD";

  const narratorPrice =
    botTick?.position?.entryPrice ??
    (typeof botTick?.lastRec?.price === "number" ? botTick!.lastRec!.price : undefined);

  const narratorThesis = botTick?.position
    ? "Explaining live open position."
    : botTick?.lastRec
    ? "Explaining latest AI pick context."
    : "No symbol yet; waiting for a pick or an entry.";

  const autoKey = botTick?.position
    ? `open:${botTick.position.ticker}@${botTick.position.entryPrice}@${botTick.position.shares}`
    : botTick?.lastRec
    ? `pick:${botTick.lastRec.ticker}@${botTick.lastRec.price ?? "?"}`
    : undefined;

  return (
    <header className="sticky top-0 z-50 w-full">
      {/* Background behind navbar */}
      <div className="w-full bg-gray-100">
        {/* Centered container */}
        <div className="mx-auto max-w-screen-2xl px-3 sm:px-6">
          {/* White rounded bar */}
          <div className="h-16 sm:h-18 flex items-center">
            <div className="w-full bg-white rounded-xl sm:rounded-2xl shadow-md border border-zinc-200 px-3 sm:px-4">
              {/* 3-column grid so the mic lives dead center */}
              <div className="h-16 sm:h-[64px] grid grid-cols-3 items-center gap-3 relative">
                {/* Left: brand */}
                <div className="justify-self-start">
                  <button
                    onClick={() => router.push("/")}
                    className="flex items-center gap-2 sm:gap-3 group"
                    aria-label="Go to Home"
                  >
                    <Image
                      src="/logo4.png"
                      alt="SmartBull Logo"
                      width={32}
                      height={32}
                      className="h-8 w-8 object-contain"
                      priority
                    />
                    <span className="text-lg sm:text-xl font-extrabold tracking-tight text-gray-900">
                      <span className="text-amber-600">Smart</span>Bull.ai
                    </span>
                  </button>
                </div>

                {/* Middle: Voice button + dropdown */}
                <div className="justify-self-center relative">
                  <button
                    ref={btnRef}
                    onClick={() => setNarratorOpen((v) => !v)}
                    title="Open Voice / Narrator"
                    aria-label="Open Voice / Narrator"
                    aria-expanded={narratorOpen}
                    className="relative inline-flex items-center justify-center h-11 w-11 rounded-full bg-black text-white shadow-sm hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-black"
                  >
                    {/* Mic icon */}
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className="h-5 w-5"
                      aria-hidden="true"
                    >
                      <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V20H8v2h8v-2h-3v-2.08A7 7 0 0 0 19 11h-2z" />
                    </svg>
                  </button>

                  {/* Dropdown panel */}
                  {narratorOpen && (
                    <div
                      ref={popRef}
                      role="dialog"
                      aria-label="Trade Narrator"
                      className="absolute left-1/2 -translate-x-1/2 mt-3 w-[min(92vw,640px)] z-[60]"
                    >
                      {/* little arrow */}
                      <div className="mx-auto h-3 w-3 rotate-45 bg-white border border-zinc-200 -mb-1"></div>
                      <div className="rounded-2xl border border-zinc-200 bg-white shadow-[0_12px_40px_rgba(0,0,0,0.14)] p-2">
                        <TradeNarrator
                          className="w-full"
                          autoRunKey={autoKey}
                          input={{
                            symbol: narratorSymbol,
                            price: typeof narratorPrice === "number" ? narratorPrice : undefined,
                            thesis: narratorThesis,
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Right: actions */}
                <div className="justify-self-end flex items-center gap-2 sm:gap-3">
                  {/* Time pill */}
                  <span className="hidden sm:inline-flex items-center rounded-md border border-gray-300 bg-gray-50 text-gray-700 px-3 py-1 text-xs font-medium font-mono">
                    {time || "--:--:--"}
                  </span>

                  {/* My P&L */}
                  <button
                    onClick={() => router.push("/pnl")}
                    className="inline-flex items-center rounded-lg border border-gray-400/70 bg-white px-3 sm:px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50"
                  >
                    My P&L
                  </button>

                  {/* Sign Out */}
                  <button
                    onClick={() => signOut({ callbackUrl: "/" })}
                    className="inline-flex items-center rounded-lg bg-black text-white px-3 sm:px-4 py-2 text-sm font-semibold hover:bg-gray-900"
                  >
                    Sign Out
                  </button>
                </div>
              </div>
              {/* end grid */}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
