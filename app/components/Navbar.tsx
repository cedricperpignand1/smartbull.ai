"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { signOut } from "next-auth/react";
import TradeNarrator from "./TradeNarrator";

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

  // Clock
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

  // Poll bot tick when narrator dropdown is open
  useEffect(() => {
    if (!narratorOpen) return;
    let cancelled = false;
    const run = async () => {
      try {
        const r = await fetch("/api/bot/tick", { cache: "no-store" });
        const j = await r.json();
        if (!cancelled) setBotTick(j);
      } catch {}
    };
    run();
    const id = setInterval(run, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [narratorOpen]);

  // Close narrator dropdown on outside click / ESC
  useEffect(() => {
    if (!narratorOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setNarratorOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setNarratorOpen(false);
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [narratorOpen]);

  // Narrator defaults
  const narratorSymbol = botTick?.position?.ticker ?? botTick?.lastRec?.ticker ?? "TBD";
  const narratorPrice =
    botTick?.position?.entryPrice ??
    (typeof botTick?.lastRec?.price === "number" ? botTick!.lastRec!.price : undefined);
  const narratorThesis = botTick?.position
    ? "Explaining live open position."
    : botTick?.lastRec
    ? "Explaining latest AI pick context."
    : "No symbol yet; waiting for a pick or an entry.";
  const autoKey =
    botTick?.position
      ? `open:${botTick.position.ticker}@${botTick.position.entryPrice}@${botTick.position.shares}`
      : botTick?.lastRec
      ? `pick:${botTick.lastRec.ticker}@${botTick.lastRec.price ?? "?"}`
      : undefined;

  return (
    <header className="sticky top-0 z-50 w-full">
      {/* Frosted glass bar over bluebackground.png */}
      <div
        className="
          h-16 md:h-18
          w-full
          bg-white/20 backdrop-blur-lg
          border-b border-white/30
          shadow-sm
        "
      >
        <div className="mx-auto max-w-screen-2xl h-full px-4 flex items-center justify-between">
          {/* LEFT: Logo + Name */}
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

          {/* CENTER: Mic / Narrator */}
          <div className="relative">
            <button
              ref={btnRef}
              onClick={() => setNarratorOpen((v) => !v)}
              title="Open Voice / Narrator"
              aria-label="Open Voice / Narrator"
              aria-expanded={narratorOpen}
              className="
                inline-flex items-center justify-center
                h-12 w-12
                rounded-full
                bg-white/30 hover:bg-white/40
                ring-1 ring-white/40
                shadow
                text-white
                transition
              "
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor"
                viewBox="0 0 24 24" className="h-6 w-6">
                <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V20H8v2h8v-2h-3v-2.08A7 7 0 0 0 19 11h-2z" />
              </svg>
            </button>

            {narratorOpen && (
              <div
                ref={popRef}
                role="dialog"
                aria-label="Trade Narrator"
                className="absolute left-1/2 -translate-x-1/2 mt-3 w-[min(92vw,680px)] z-[60]"
              >
                <div className="mx-auto h-3 w-3 rotate-45 bg-white border border-zinc-200 -mb-1"></div>
                <div className="rounded-2xl border border-zinc-200 bg-white shadow-lg p-3">
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

          {/* RIGHT: Time + Buttons */}
          <div className="flex items-center gap-4">
            <span
              className="
                hidden sm:inline-flex items-center
                rounded-md px-3 py-1.5 text-sm md:text-base font-medium font-mono
                bg-white/25 ring-1 ring-white/35 text-white
              "
            >
              {time || "--:--:--"}
            </span>

            <button
              onClick={() => router.push("/pnl")}
              className="
                inline-flex items-center rounded-md
                px-4 py-2 text-base font-semibold
                bg-white/25 hover:bg-white/35
                text-white ring-1 ring-white/35
                transition
              "
            >
              My P&L
            </button>

            <button
              onClick={() => signOut({ callbackUrl: "/" })}
              className="
                inline-flex items-center rounded-md
                px-4 py-2 text-base font-semibold
                bg-white text-black hover:bg-gray-50
                shadow-sm
                transition
              "
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
