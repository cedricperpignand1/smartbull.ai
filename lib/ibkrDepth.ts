// /lib/ibkrDepth.ts
// SERVER-ONLY MODULE

// Lazy CJS require to avoid ESM issues in Next
// and to guarantee this only loads on the server.
let IBCtor: any = null;
function getIB() {
  if (!IBCtor) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    IBCtor = require("ib");
  }
  return IBCtor;
}

type DepthLevel = { px: number; sz: number };
type DepthBook = { bids: DepthLevel[]; asks: DepthLevel[] };

const MAX_LEVELS = 10;

function emptyBook(): DepthBook {
  return { bids: [], asks: [] };
}

function toContract(symbol: string, exchange: string) {
  return {
    symbol,
    secType: "STK",
    exchange,        // "ISLAND" or "NASDAQ" etc.
    currency: "USD",
    primaryExch: "NASDAQ",
  };
}

class DepthBus {
  ib: any | null = null;
  connecting = false;
  connected = false;

  // key = `${symbol}::${exchange}`
  subs = new Map<string, {
    tickerId: number;
    book: DepthBook;
    listeners: Set<(book: DepthBook) => void>;
    handler: ((...args: any[]) => void) | null;
  }>();

  seq = 1000;

  async ensureConnected() {
    if (this.connected || this.connecting) return;
    this.connecting = true;

    const host = process.env.IB_HOST || "127.0.0.1";
    const port = Number(process.env.IB_PORT || 7497);
    const clientId = Number(process.env.IB_CLIENT_ID || 33);

    const IB = getIB();
    this.ib = new IB({ host, port, clientId });

    await new Promise<void>((resolve) => {
      this.ib.once("connected", () => {
        this.connected = true;
        resolve();
      });
      this.ib.connect();
    });

    // Log useful server errors, but filter noisy farm messages
    this.ib.on("error", (err: any) => {
      const msg = String(err?.message ?? err ?? "");
      if (/market data farm connection is OK/i.test(msg)) return;
      // Permission error example: "No market depth permissions for ISLAND"
      console.error("[IB ERROR]", msg);
    });

    this.ib.on("disconnected", () => {
      this.connected = false;
    });

    // Optional: discover depth venues
    try { this.ib.reqMktDepthExchanges(); } catch {}
    this.connecting = false;
  }

  subscribe(symbol: string, exchange: string, onUpdate: (b: DepthBook) => void) {
    const key = `${symbol}::${exchange}`;
    let sub = this.subs.get(key);
    if (!sub) {
      sub = {
        tickerId: this.seq++,
        book: emptyBook(),
        listeners: new Set(),
        handler: null,
      };
      this.subs.set(key, sub);

      const c = toContract(symbol, exchange);
      // Request up to 20 levels per side (exchange/permits permitting)
      this.ib!.reqMktDepth(sub.tickerId, c, 20);

      // Create a dedicated handler for this tickerId
      const handler = (tickerId: number, position: number, operation: number, side: number, price: number, size: number) => {
        if (tickerId !== sub!.tickerId) return;
        const isBid = side === 0;
        const arr = isBid ? sub!.book.bids : sub!.book.asks;

        // 0=insert, 1=update, 2=delete
        if (operation === 2) {
          if (arr[position]) arr.splice(position, 1);
        } else {
          const lvl = { px: Number(price), sz: Number(size) };
          if (operation === 0) arr.splice(position, 0, lvl);
          else arr[position] = lvl;
        }

        // Clean and sort
        sub!.book.bids = (sub!.book.bids || []).filter(x => x && x.sz > 0).sort((a, b) => b.px - a.px).slice(0, MAX_LEVELS);
        sub!.book.asks = (sub!.book.asks || []).filter(x => x && x.sz > 0).sort((a, b) => a.px - b.px).slice(0, MAX_LEVELS);

        // Notify listeners
        sub!.listeners.forEach(fn => fn(sub!.book));
      };

      sub.handler = handler;
      this.ib!.on("updateMktDepth", handler);
    }

    sub.listeners.add(onUpdate);

    return {
      unsubscribe: () => {
        sub!.listeners.delete(onUpdate);
        if (sub!.listeners.size === 0) {
          try { this.ib!.cancelMktDepth(sub!.tickerId); } catch {}
          if (sub!.handler) {
            this.ib!.off?.("updateMktDepth", sub!.handler);
          }
          this.subs.delete(key);
        }
      }
    };
  }
}

export const depthBus = new DepthBus();
export async function ensureIB() {
  await depthBus.ensureConnected();
}
