// app/api/alpaca/account/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { nowET } from "@/lib/market";

/** ---------- Alpaca client (uses server envs) ---------- */
const RAW_BASE = (process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets").trim();
// normalize: no trailing slash, no trailing /v2 (we add /v2 in paths below)
const BASE = RAW_BASE.replace(/\/+$/, "").replace(/\/v2$/, "");

const KEY =
  process.env.ALPACA_API_KEY_ID ||
  process.env.ALPACA_API_KEY ||
  process.env.NEXT_PUBLIC_ALPACA_API_KEY_ID || // allow dev
  "";
const SEC =
  process.env.ALPACA_API_SECRET_KEY ||
  process.env.ALPACA_SECRET_KEY ||
  process.env.NEXT_PUBLIC_ALPACA_API_SECRET_KEY || // allow dev
  "";

async function alpGet(path: string) {
  if (!KEY || !SEC) throw new Error("Missing Alpaca API credentials in env.");
  const url = `${BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  const r = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": KEY,
      "APCA-API-SECRET-KEY": SEC,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!r.ok) {
    const msg = json?.message || json?.error || text || `HTTP ${r.status}`;
    throw new Error(`Alpaca GET ${path} ${r.status}: ${msg}`);
  }
  return json;
}

/** ---------- Route ---------- */
export async function GET() {
  try {
    // /v2/account returns equity, last_equity, cash, buying_power, etc.
    const acct = await alpGet("/v2/account");

    const equity = Number(acct?.equity ?? NaN);
    const lastEq = Number(acct?.last_equity ?? NaN);
    const cash   = Number(acct?.cash ?? NaN);
    const buying = Number(acct?.buying_power ?? NaN);

    const dayPnL = (Number.isFinite(equity) && Number.isFinite(lastEq))
      ? equity - lastEq
      : null;
    const dayPnLPct = (dayPnL != null && Number.isFinite(equity) && equity !== 0)
      ? dayPnL / lastEq
      : null;

    return NextResponse.json({
      ok: true,
      account: {
        cash: Number.isFinite(cash) ? cash : null,
        equity: Number.isFinite(equity) ? equity : null,
        last_equity: Number.isFinite(lastEq) ? lastEq : null,
        buying_power: Number.isFinite(buying) ? buying : null,
        day_pnl: dayPnL,
        day_pnl_pct: dayPnLPct,
        pattern_day_trader: acct?.pattern_day_trader ?? null,
        timestampET: nowET().toISOString(),
      },
      base: BASE,
    });
  } catch (e: any) {
    console.error("[alpaca/account] error:", e?.message || e);
    return NextResponse.json({ ok: false, error: e?.message || "account_error" }, { status: 500 });
  }
}
