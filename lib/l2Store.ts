import { buyPressure, type L2Book, type L2Level } from "./l2-Pressure";

const BOOKS = new Map<string, L2Book>();

export function upsertBook(sym: string, bids: L2Level[], asks: L2Level[]) {
  bids.sort((a, b) => b.px - a.px); // highest bid first
  asks.sort((a, b) => a.px - b.px); // lowest ask first

  const prev = BOOKS.get(sym);
  const history = (prev?.history || []).concat({
    t: Date.now(),
    bidPx: bids[0]?.px ?? 0,
    askPx: asks[0]?.px ?? 0,
    bidSz: bids[0]?.sz ?? 0,
    askSz: asks[0]?.sz ?? 0,
  }).slice(-30); // keep last 30 updates

  BOOKS.set(sym, { bids, asks, history });
}

export function pressure(sym: string) {
  const book = BOOKS.get(sym);
  if (!book) return null;
  return buyPressure(book);
}

// ✅ explicitly export the types so other files can import cleanly
export type { L2Level, L2Book } from "./l2-Pressure";
