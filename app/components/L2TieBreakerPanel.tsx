"use client";

import { useEffect, useMemo, useState } from "react";
import { useOrderBook } from "./useOrderBook";

type ScoreResult = {
  ok: boolean;          // passed guardrails
  score: number;        // composite 0..100-ish
  details: {
    cdi: number;        // cumulative depth imbalance
    tob: number;        // top-of-book pressure
    microBiasBps: number; // negative is bullish (skew toward bid)
    spreadBps: number;
    bidSum: number;
    askSum: number;
  };
};

function clip(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

// Compute features from a book snapshot
function computeFeatures(snap: ReturnType<typeof useOrderBook>["snap"]) {
  if (!snap) return null;
  const { bids, asks, spreadBps, mid } = snap;

  const bidSum = bids.reduce((a, b) => a + b.sz, 0);
  const askSum = asks.reduce((a, b) => a + b.sz, 0);
  const cdi = (bidSum - askSum) / Math.max(1, bidSum + askSum); // -1..+1

  const b1sz = bids[0]?.sz ?? 0;
  const a1sz = asks[0]?.sz ?? 0;
  const tob = (b1sz - a1sz) / Math.max(1, b1sz + a1sz); // -1..+1

  const bestBid = bids[0]?.px ?? 0;
  const bestAsk = asks[0]?.px ?? 0;
  const microPx = (bestAsk * b1sz + bestBid * a1sz) / Math.max(1, b1sz + a1sz);
  const microBias = (microPx - (bestBid && bestAsk ? (bestBid + bestAsk) / 2 : mid)) / Math.max(1e-9, mid);
  const microBiasBps = microBias * 10000; // negative = bullish

  return { cdi, tob, microBiasBps, spreadBps, bidSum, askSum };
}

function scoreBook(snap: ReturnType<typeof useOrderBook>["snap"]): ScoreResult {
  if (!snap) return { ok: false, score: -999, details: { cdi: 0, tob: 0, microBiasBps: 0, spreadBps: 0, bidSum: 0, askSum: 0 } };
  const f = computeFeatures(snap)!;

  // Guardrails (safety first)
  if (!Number.isFinite(f.spreadBps) || f.spreadBps <= 0) {
    return { ok: false, score: -999, details: { ...f } };
  }
  if (f.spreadBps > 20) {
    return { ok: false, score: -999, details: { ...f } };
  }

  // Heuristic weights (intraday, L2-only)
  // Favor deeper bids (cdi), stronger top-of-book, and negative microBiasBps.
  const microZ = clip((-f.microBiasBps) / 5, -2, 2); // 5 bps ~= 1 "std" guess

  const spreadBonus = f.spreadBps <= 8 ? 5 : f.spreadBps <= 12 ? 2 : -5;

  const score =
    25 * clip(f.cdi, -0.5, 0.5) +
    20 * clip(f.tob, -0.5, 0.5) +
    15 * microZ +
    spreadBonus;

  return { ok: true, score: Math.round(score), details: f };
}

function Badge({ ok, score }: { ok: boolean; score: number }) {
  const yes = ok && score >= 20;
  const cls = yes ? "bg-emerald-600" : "bg-slate-600";
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold text-white ${cls}`}>
      Safer long: {yes ? "YES" : "NO"}
    </span>
  );
}

export default function L2TieBreakerPanel({
  a,
  b,
  height = 220,
}: {
  a: string;
  b: string;
  height?: number;
}) {
  const { snap: sa } = useOrderBook({ symbol: a, mock: false, depth: 10 });
  const { snap: sb } = useOrderBook({ symbol: b, mock: false, depth: 10 });

  const resA = useMemo(() => scoreBook(sa), [sa]);
  const resB = useMemo(() => scoreBook(sb), [sb]);

  const pick = useMemo(() => {
    if (!resA.ok && !resB.ok) return null;
    if (!resA.ok) return { winner: "B", reason: "A failed guardrails" };
    if (!resB.ok) return { winner: "A", reason: "B failed guardrails" };
    if (resA.score > resB.score + 4) return { winner: "A", reason: "Higher score" };
    if (resB.score > resA.score + 4) return { winner: "B", reason: "Higher score" };
    // tie-breaker: tighter spread wins
    const spreadA = resA.details.spreadBps ?? 99;
    const spreadB = resB.details.spreadBps ?? 99;
    if (spreadA !== spreadB) return { winner: spreadA < spreadB ? "A" : "B", reason: "Tighter spread" };
    // else: deeper bid depth
    if (resA.details.bidSum !== resB.details.bidSum) return { winner: resA.details.bidSum > resB.details.bidSum ? "A" : "B", reason: "Deeper bids" };
    return { winner: "A", reason: "Near tie" };
  }, [resA, resB]);

  return (
    <div className="h-full flex flex-col bg-white rounded-2xl border border-gray-200 shadow-[0_8px_24px_rgba(0,0,0,0.06)] overflow-hidden"
         style={{ height }}>
      <div className="px-4 py-2.5 flex items-center justify-between border-b border-gray-200 bg-white">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center px-3 py-1 rounded-md text-xs font-semibold text-white bg-blue-600">
            L2 Tie-Breaker
          </span>
          <span className="text-xs text-slate-600">Comparing <b className="font-mono">{a}</b> vs <b className="font-mono">{b}</b></span>
        </div>
        <div className="flex items-center gap-2">
          <Badge ok={resA.ok} score={resA.score} />
          <span className="text-xs text-slate-500">A: {resA.score}</span>
          <span className="text-slate-300">|</span>
          <Badge ok={resB.ok} score={resB.score} />
          <span className="text-xs text-slate-500">B: {resB.score}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 p-3 text-xs">
        <div className="rounded-lg border border-slate-200 p-2">
          <div className="font-semibold mb-1">{a}</div>
          <div>Spread: {resA.details.spreadBps?.toFixed?.(2) ?? "—"} bps</div>
          <div>CDI (Σ): {(resA.details.cdi * 100).toFixed(1)}%</div>
          <div>ToB: {(resA.details.tob * 100).toFixed(1)}%</div>
          <div>MicroBias: {resA.details.microBiasBps?.toFixed?.(1)} bps</div>
          <div>BidΣ / AskΣ: {resA.details.bidSum ?? 0} / {resA.details.askSum ?? 0}</div>
        </div>

        <div className="rounded-lg border border-slate-200 p-2">
          <div className="font-semibold mb-1">{b}</div>
          <div>Spread: {resB.details.spreadBps?.toFixed?.(2) ?? "—"} bps</div>
          <div>CDI (Σ): {(resB.details.cdi * 100).toFixed(1)}%</div>
          <div>ToB: {(resB.details.tob * 100).toFixed(1)}%</div>
          <div>MicroBias: {resB.details.microBiasBps?.toFixed?.(1)} bps</div>
          <div>BidΣ / AskΣ: {resB.details.bidSum ?? 0} / {resB.details.askSum ?? 0}</div>
        </div>
      </div>

      <div className="px-4 pb-3 text-sm">
        {pick ? (
          <div className="inline-flex items-center gap-2">
            <span className="font-semibold">Safer long →</span>
            <span className="px-2 py-0.5 rounded-md bg-emerald-600 text-white font-mono">
              {pick.winner === "A" ? a : b}
            </span>
            <span className="text-xs text-slate-500">({pick.reason})</span>
          </div>
        ) : (
          <span className="text-slate-500">Waiting for live depth…</span>
        )}
      </div>
    </div>
  );
}
