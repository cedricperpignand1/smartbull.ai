// app/api/industry-winner/route.ts
import { NextResponse } from "next/server";
import { fmpProfileCached } from "../../../lib/fmpCached"; // keep path consistent

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// simple in-memory cache keyed by tickers+date
const CACHE = new Map<string, { ts: number; data: any }>();
const TTL_MS = 10 * 60 * 1000; // 10 minutes

type ReqBody = { tickers?: string[] };

function cacheKey(tickers: string[]) {
  const day = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
  return `${day}:${tickers.map(t => t.toUpperCase()).sort().join(",")}`;
}

function normalizeLabel(s: any) {
  const x = String(s || "").trim();
  if (!x) return null;
  // Basic cleanup; add your own mapping if needed
  return x;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ReqBody;
    const tickers = (body?.tickers ?? []).map(t => String(t).toUpperCase()).slice(0, 13);
    if (!tickers.length) {
      return NextResponse.json({ ok: false, error: "No tickers provided" }, { status: 400 });
    }

    // cache
    const key = cacheKey(tickers);
    const now = Date.now();
    const cached = CACHE.get(key);
    if (cached && now - cached.ts < TTL_MS) {
      return NextResponse.json(cached.data);
    }

    // fetch profiles (parallel)
    const profiles = await Promise.all(
      tickers.map(async (t) => {
        try {
          const p = await fmpProfileCached(t);
          const industry = normalizeLabel(p?.industry);
          const sector = normalizeLabel(p?.sector);
          return { ticker: t, industry, sector };
        } catch {
          return { ticker: t, industry: null, sector: null };
        }
      })
    );

    // group by industry (fallback to sector if industry missing)
    const map = new Map<string, string[]>();
    for (const row of profiles) {
      const label = row.industry || row.sector || "Unknown";
      const arr = map.get(label) || [];
      arr.push(row.ticker);
      map.set(label, arr);
    }

    // find winner by count (ties -> keep the one with more members alphabetically sorted earliest)
    const groups = Array.from(map.entries()).map(([label, members]) => ({
      label,
      count: members.length,
      members: members.sort(),
    }));
    groups.sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label));
    const winner = groups[0];

    const data = {
      ok: true,
      winner,   // { label, count, members }
      groups,   // all groups
      fetched: profiles, // per-ticker industry/sector
      ts: new Date().toISOString(),
      ttlSeconds: TTL_MS / 1000,
    };

    CACHE.set(key, { ts: now, data });
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "failed" }, { status: 500 });
  }
}
