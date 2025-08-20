export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { getAccount, getClock, getAsset } from "@/lib/alpaca";

/**
 * GET /api/alpaca/health?symbol=SPY
 * Quick sanity check for:
 *  - account status & buying power
 *  - market clock (is the market actually open?)
 *  - asset tradability for a given symbol (default SPY)
 */
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
        status: acct.status,                  // 'ACTIVE' expected
        account_blocked: acct.account_blocked,
        buying_power: acct.buying_power,
        multiplier: acct.multiplier,
        daytrade_count: acct.daytrade_count,
        shorting_enabled: acct.shorting_enabled,
        trade_suspended_by_user: acct.trade_suspended_by_user,
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
        status: asset.status,                // 'active' expected
        class: asset.class,
        fractionable: asset.fractionable,
        easy_to_borrow: asset.easy_to_borrow,
        marginable: asset.marginable,
      },
    };

    return NextResponse.json({ ok: true, summary });
  } catch (e: any) {
    const msg = e?.message || String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  // allow POST for convenience (same as GET)
  return GET(req);
}
