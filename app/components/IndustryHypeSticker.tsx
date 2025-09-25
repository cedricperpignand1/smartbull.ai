"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Flame, TrendingUp } from "lucide-react";

/** Rows the sticker expects. % can be 8.5 or 0.085 — both accepted. */
export type TickerRow = {
  ticker: string;
  changesPercentage?: number | null;
  dollarVolume?: number | null;
  sector?: string | null;
  industry?: string | null;
};

type Tone = "bull" | "bear" | "neutral";

type Props = {
  rows: TickerRow[] | undefined;
  /** Prefer grouping by this key; auto-fallback to the other if missing */
  groupBy?: "industry" | "sector";
  /** Minimum names required per group (1 = always show something) */
  minNames?: number;
  /** Extra classes for the badge wrapper */
  className?: string;

  /** SPY tone source (server endpoint that returns { tone, pct }) */
  toneEndpoint?: string; // default: /api/market/tone
  /** Force tone for testing (overrides fetch) */
  forceTone?: Tone;

  /** NEW: when you already know the winner industry (e.g., from FMP API), show this label instead of computed one */
  overrideLabel?: string;
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const toPct = (x: number | null | undefined): number | null => {
  if (x == null || !Number.isFinite(Number(x))) return null;
  const n = Number(x);
  return Math.abs(n) <= 1.2 ? n * 100 : n; // 0.085 -> 8.5
};
const median = (nums: number[]): number => {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const zScore = (x: number, mean: number, sd: number): number => {
  if (!Number.isFinite(sd) || sd === 0) return 0;
  return (x - mean) / sd;
};

function IndustryHypeSticker({
  rows,
  groupBy = "industry",
  minNames = 1,
  className = "",
  toneEndpoint = "/api/market/tone",
  forceTone,
  overrideLabel,
}: Props) {
  /** ===== 1) Figure out the *hottest group* from your rows ===== */
  const best = useMemo(() => {
    const data = (rows || []).filter(r => !!r?.ticker);
    if (!data.length) return null;

    // Resolve grouping key: prefer chosen, fallback to the other
    const keyOf = (r: TickerRow) => {
      const primary = (groupBy === "industry" ? r.industry : r.sector) ?? "";
      const secondary = (groupBy === "industry" ? r.sector : r.industry) ?? "";
      return String(primary || secondary || "Unknown").trim();
    };

    // Group rows
    const map = new Map<string, TickerRow[]>();
    for (const r of data) {
      const k = keyOf(r) || "Unknown";
      const arr = map.get(k) || [];
      arr.push(r);
      map.set(k, arr);
    }

    // If we have any labeled group, drop Unknown so real labels win
    const hasLabeled = Array.from(map.keys()).some(k => k !== "Unknown");
    if (hasLabeled && map.has("Unknown")) map.delete("Unknown");

    // Compute per-group metrics
    let groups = Array.from(map.entries()).map(([key, arr]) => {
      const pctList = arr.map(r => toPct(r.changesPercentage)).filter((v): v is number => v != null);
      const medPct = median(pctList);
      const dvSum = arr.map(r => r.dollarVolume ?? 0).filter(v => Number.isFinite(v)).reduce((a, b) => a + b, 0);
      return { key, arr, medPct, dvSum };
    });

    // Enforce minNames; if that empties, fallback to a Mixed group of ALL rows
    groups = groups.filter(g => g.arr.length >= minNames);
    if (!groups.length) {
      const pctList = data.map(r => toPct(r.changesPercentage)).filter((v): v is number => v != null);
      const medPct = median(pctList);
      const dvSum = data.map(r => r.dollarVolume ?? 0).filter(v => Number.isFinite(v)).reduce((a, b) => a + b, 0);
      groups = [{ key: "Mixed", arr: data, medPct, dvSum }];
    }

    // Liquidity z across groups
    const dvSums = groups.map(g => g.dvSum);
    const mean = dvSums.reduce((a, b) => a + b, 0) / dvSums.length;
    const sd = Math.sqrt(
      dvSums.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / Math.max(1, dvSums.length - 1)
    );
    const totalNames = groups.reduce((a, g) => a + g.arr.length, 0);

    // Score 0–100 (Momentum 45% + Liquidity 35% + Participation 20%)
    const scored = groups
      .map(g => {
        const momentum = clamp01((g.medPct + 5) / 15);                 // -5%..+10% -> 0..1
        const liquidity = clamp01((zScore(g.dvSum, mean, sd) + 2) / 4); // z -2..+2 -> 0..1
        const participation = clamp01(g.arr.length / Math.max(3, totalNames));
        const score = 100 * (0.45 * momentum + 0.35 * liquidity + 0.20 * participation);
        return { ...g, score };
      })
      .sort((a, b) => b.score - a.score);

    return scored[0];
  }, [rows, groupBy, minNames]);

  /** ===== 2) Fetch market tone (SPY) with tiny, cached server API ===== */
  const [tone, setTone] = useState<Tone>("neutral");
  const [spyPct, setSpyPct] = useState<number | null>(null);

  useEffect(() => {
    if (forceTone) { setTone(forceTone); return; }

    let stop = false;
    let ac: AbortController | null = null;

    const fetchTone = async () => {
      try {
        ac = new AbortController();
        const r = await fetch(toneEndpoint, { cache: "no-store", signal: ac.signal });
        const j = await r.json();
        if (!stop && j?.tone) {
          setTone(j.tone as Tone);
          setSpyPct(typeof j.pct === "number" ? j.pct : null);
        }
      } catch { /* ignore */ }
    };

    fetchTone();
    const id = setInterval(fetchTone, 30_000); // poll every 30s; server caches ~15s
    return () => { stop = true; ac?.abort(); clearInterval(id); };
  }, [toneEndpoint, forceTone]);

  if (!best) return null;

  // Label: rename Unknown -> Mixed; allow override when provided
  const computedLabel = best.key === "Unknown" ? "Mixed" : best.key;
  const label = overrideLabel || computedLabel;

  // Color classes by SPY tone
  const toneClasses =
    tone === "bull"
      ? "bg-green-50 text-green-700 border-green-200"
      : tone === "bear"
      ? "bg-red-50 text-red-700 border-red-200"
      : "bg-slate-50 text-slate-700 border-slate-200";

  return (
    <div
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs shadow-sm",
        "hover:shadow transition-shadow",
        toneClasses,
        className,
      ].join(" ")}
      title={
        `Top Group: ${label}` +
        ` | Median %: ${best.medPct.toFixed(2)}` +
        ` | Names: ${best.arr.length}` +
        ` | Hype: ${best.score.toFixed(1)}` +
        (spyPct != null ? ` | S&P: ${spyPct.toFixed(2)}%` : "") +
        ` | Tickers: ${best.arr.slice(0, 3).map(r => r.ticker).join(", ")}${best.arr.length > 3 ? "…" : ""}`
      }
    >
      {tone === "bull" && <TrendingUp className="h-3.5 w-3.5" />}
      {tone === "bear" && <Flame className="h-3.5 w-3.5 rotate-180" />}
      {tone === "neutral" && <TrendingUp className="h-3.5 w-3.5 opacity-60" />}

      <span className="font-semibold tracking-wide">
        {label} <span className="opacity-60">•</span> {tone === "bull" ? "Bullish" : tone === "bear" ? "Bearish" : "Neutral"}
      </span>

      <span className="opacity-70">•</span>
      <span className="font-medium">{best.medPct.toFixed(1)}%</span>

      <span className="opacity-70">•</span>
      <span className="opacity-80">Hype {Math.round(best.score)}</span>
    </div>
  );
}

export default IndustryHypeSticker;
export { IndustryHypeSticker };
