// /app/api/l2/stream/route.ts
import { NextRequest } from "next/server";
// If you DON'T have the "@" alias, switch this to a relative path:
import { depthBus, ensureIB } from "@/lib/ibkrDepth";

// VERY IMPORTANT: this must NOT run in the Edge runtime
export const runtime = "nodejs";
// We want a live stream, not static
export const dynamic = "force-dynamic";

function toSnapshot(book: { bids: {px:number;sz:number}[]; asks: {px:number;sz:number}[] }) {
  const bestBid = book.bids[0]?.px ?? 0;
  const bestAsk = book.asks[0]?.px ?? 0;
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk || 0);
  const spreadBps = (bestBid && bestAsk && mid) ? ((bestAsk - bestBid) / mid) * 10000 : 0;

  return {
    bids: book.bids,
    asks: book.asks,
    bestBid,
    bestAsk,
    mid,
    spreadBps: Number.isFinite(spreadBps) ? +spreadBps.toFixed(2) : 0,
    ts: Date.now()
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") || "AAPL").toUpperCase();
  const exchange = searchParams.get("exchange") || process.env.IB_EXCHANGE || "ISLAND";

  await ensureIB();

  const stream = new ReadableStream({
    start(controller) {
      const enc = (obj: any) => `data: ${JSON.stringify(obj)}\n\n`;
      controller.enqueue(new TextEncoder().encode(`retry: 3000\n`)); // SSE retry hint

      const sub = depthBus.subscribe(symbol, exchange, (book) => {
        controller.enqueue(new TextEncoder().encode(enc(toSnapshot(book))));
      });

      // Close when the client disconnects
      // @ts-ignore - not all runtimes expose signal here
      controller.signal?.addEventListener?.("abort", () => sub.unsubscribe());
    },
    cancel() { /* no-op */ }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
