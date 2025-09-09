import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const symbolsParam = req.nextUrl.searchParams.get("symbols") || "";
    const symbols = symbolsParam
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    // dummy neutral stats so code can run without a backend
    const stats: Record<string, any> = {};
    for (const s of symbols) {
      stats[s] = {
        symbol: s,
        buyCount: 0,
        sellCount: 0,
        buyNotional: 0,
        sellNotional: 0,
      };
    }

    return NextResponse.json({ ok: true, stats });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "quick-stats error" }, { status: 500 });
  }
}
