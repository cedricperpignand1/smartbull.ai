// /app/api/stocks/stream/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  ensureStocksWorkerStarted,
  subscribe,
  getLatestPayload,
} from "../../../../lib/stocksWorker";

/** UI knobs */
const DISPLAY_LIMIT = 15;
const MIN_VOLUME = 300_000; // strict: never show below 300k intraday

type Stock = {
  ticker: string;
  price?: number | null;
  changesPercentage?: number | null;
  marketCap?: number | null;
  sharesOutstanding?: number | null;
  volume?: number | null;
  avgVolume?: number | null;
  employees?: number | null;
};

const ESSENTIAL_FIELDS: (keyof Stock)[] = [
  "ticker",
  "price",
  "changesPercentage",
  "marketCap",
  "sharesOutstanding",
  "volume",
  "avgVolume",
  "employees",
];

/** Keep only the fields the UI needs, filter by vol ≥ 300k, sort by % change, cap to 15 */
function transformPayload(payload: any) {
  const all: Stock[] = Array.isArray(payload?.stocks) ? payload.stocks : [];

  // sanitize (strip extra keys so we send smaller SSE frames)
  const sanitized: Stock[] = all.map((s: any) => {
    const out: any = {};
    for (const k of ESSENTIAL_FIELDS) out[k] = s?.[k] ?? null;
    // ticker must be uppercase string
    out.ticker = String(s?.ticker || s?.symbol || "").toUpperCase();
    return out as Stock;
  }).filter(s => !!s.ticker);

  // hard filter: do NOT show sub-300k volume rows
  const filtered = sanitized
    .filter((s) => (s.volume ?? 0) >= MIN_VOLUME)
    .sort(
      (a, b) =>
        (b.changesPercentage ?? -Infinity) - (a.changesPercentage ?? -Infinity)
    );

  const out = filtered.slice(0, DISPLAY_LIMIT);

  return {
    ...payload,
    stocks: out,
    sourceUsed: payload?.sourceUsed ?? "FMP",
    updatedAt: payload?.updatedAt ?? new Date().toISOString(),
    // debug hints
    _minVolumeApplied: MIN_VOLUME,
    _qualifiedBeforeSlice: filtered.length,
    _sentCount: out.length,
  };
}

/** create a compact signature so we only send when something actually changed */
function signature(obj: any): string {
  const rows: Stock[] = Array.isArray(obj?.stocks) ? obj.stocks : [];
  return rows
    .map((s) => [
      s.ticker,
      s.volume ?? "",
      s.price ?? "",
      s.changesPercentage ?? "",
      s.marketCap ?? "",
      s.sharesOutstanding ?? "",
      s.avgVolume ?? "",
      s.employees ?? "",
    ].join("|"))
    .join(",");
}

export async function GET() {
  ensureStocksWorkerStarted();

  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: any) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      // Initial comment line to open SSE
      controller.enqueue(encoder.encode(`: connected\n\n`));

      // Send the latest snapshot immediately
      let lastSig = "";
      const initial = transformPayload(getLatestPayload() ?? {});
      lastSig = signature(initial);
      send(initial);

      // Keep-alive
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(ping);
          cleanup?.();
        }
      }, 20_000);

      // Forward worker updates, but only when they materially change
      const unsubscribe = subscribe((payload: any) => {
        try {
          const t = transformPayload(payload ?? {});
          const sig = signature(t);
          if (sig !== lastSig) {
            lastSig = sig;
            send(t);
          }
        } catch {
          clearInterval(ping);
          unsubscribe();
          try { controller.close(); } catch {}
        }
      });

      cleanup = () => {
        clearInterval(ping);
        unsubscribe();
        try { controller.close(); } catch {}
      };
    },
    cancel() { cleanup?.(); },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
