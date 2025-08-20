export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { getAccount, getClock, getAsset } from "@/lib/alpaca";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const symbol = (url.searchParams.get("symbol") || "SPY").toUpperCase();

    const [acct, clock, asset] = await Promise.all([
      getAccount(),
      getClock(),
      getAsset(symbol),
    ]);

    const summary = {
      envBaseUrl: process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets",
      account: {
        paper: acct.paper,
        status: acct.status,
        account_blocked: acct.account_blocked,
        buying_power: acct.buying_power,
        daytrade_count: acct.daytrade_count,
      },
      clock: {
        is_open: clock.is_open,
        next_open: clock.next_open,
        next_close: clock.next_close,
        timestamp: clock.timestamp,
      },
      asset: {
        symbol,
        tradable: asset.tradable,
        status: asset.status,
        fractionable: asset.fractionable,
        marginable: asset.marginable,
      },
    };

    return NextResponse.json({ ok: true, summary });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) { return GET(req); }
