// /app/api/dashboard/summary/route.ts
import { NextResponse } from "next/server";

const TTL_MS = 4000;
let cache: { data: any | null; t: number; pending: Promise<any> | null } = {
  data: null, t: 0, pending: null
};

async function fetchAll() {
  // parallel… but only 1 outer request hits each upstream per call
  const [bot, trades, alpaca] = await Promise.all([
    fetch("/api/bot/tick",   { cache: "no-store" }).then(r=>r.json()).catch(()=>null),
    fetch("/api/trades",     { cache: "no-store" }).then(r=>r.json()).catch(()=>null),
    fetch("/api/alpaca/account",{ cache: "no-store" }).then(r=>r.json()).catch(()=>null),
  ]);
  return { bot, trades, alpaca, updatedAt: new Date().toISOString() };
}

export async function GET() {
  const now = Date.now();
  if (cache.data && now - cache.t < TTL_MS) return NextResponse.json(cache.data);
  if (cache.pending) return NextResponse.json(await cache.pending);

  cache.pending = (async () => {
    try {
      const data = await fetchAll();
      cache.data = data; cache.t = Date.now();
      return data;
    } finally { cache.pending = null; }
  })();

  return NextResponse.json(await cache.pending);
}
