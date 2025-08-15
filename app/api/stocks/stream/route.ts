// /app/api/stocks/stream/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// NOTE: from /app/api/stocks/stream to /lib is FOUR levels up
// app/api/stocks/stream/route.ts -> ../../../../lib/stocksWorker
import {
  ensureStocksWorkerStarted,
  subscribe,
  getLatestPayload,
} from "../../../../lib/stocksWorker";

export async function GET() {
  ensureStocksWorkerStarted();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Helper: safe enqueue that won’t crash if the stream is closed
      const safeEnqueue = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          return false;
        }
      };

      // Send a quick comment to establish the SSE stream
      safeEnqueue(": connected\n\n");

      // Send the latest payload immediately
      const initial = getLatestPayload();
      safeEnqueue(`data: ${JSON.stringify(initial)}\n\n`);

      // Keep-alive ping every 20s
      const ping = setInterval(() => {
        if (!safeEnqueue(": ping\n\n")) {
          clearInterval(ping);
        }
      }, 20_000);

      // Subscribe to worker updates; broadcast each as SSE data
      const unsubscribe = subscribe((payload: any) => {
        if (!safeEnqueue(`data: ${JSON.stringify(payload)}\n\n`)) {
          clearInterval(ping);
          unsubscribe();
          try {
            controller.close();
          } catch {}
        }
      });

      // Store a cleanup function on the controller (used by cancel below)
      // @ts-ignore - attach custom field for cleanup
      (controller as any)._cleanup = () => {
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      };
    },

    // Called when the client disconnects / closes the EventSource
    cancel() {
      // Try to run the cleanup we stored above
      try {
        // @ts-ignore
        this?._cleanup?.();
      } catch {}
    },
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
