import { NextResponse } from "next/server";

const FMP_API_KEY = process.env.FMP_API_KEY || "M0MLRDp8dLak6yJOfdv7joKaKGSje8pp";
const ALPACA_API_KEY = process.env.ALPACA_API_KEY!;
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY!;

// In-memory cache for employee count (optional)
const employeesCache = new Map<string, { v: number | null; t: number }>();
const EMP_TTL_MS = 5 * 60 * 1000;

function isMarketOpenNow(): boolean {
  const now = new Date();
  const ny = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const d = ny.getDay();
  const h = ny.getHours();
  const m = ny.getMinutes();
  const isWeekday = d >= 1 && d <= 5;
  const isHours = (h > 9 || (h === 9 && m >= 30)) && h < 16;
  return isWeekday && isHours;
}

async function fetchQuoteAlpaca(ticker: string) {
  try {
    const url = `https://data.alpaca.markets/v2/stocks/${ticker}/quotes/latest`;
    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": ALPACA_API_KEY,
        "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const q = data?.quote;
    return {
      price: q ? (q.bp && q.ap ? (q.bp + q.ap) / 2 : q.bp || q.ap) : null,
      volume: q?.s ?? null,
    };
  } catch {
    return null;
  }
}

async function fetchQuoteFMP(ticker: string) {
  const url = `https://financialmodelingprep.com/api/v3/quote/${ticker}?apikey=${FMP_API_KEY}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function fetchEmployeesFMP(ticker: string): Promise<number | null> {
  const now = Date.now();
  const hit = employeesCache.get(ticker);
  if (hit && now - hit.t < EMP_TTL_MS) return hit.v;

  try {
    const url = `https://financialmodelingprep.com/api/v3/profile/${ticker}?apikey=${FMP_API_KEY}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      employeesCache.set(ticker, { v: null, t: now });
      return null;
    }
    const data = await res.json();
    const employees =
      Array.isArray(data) && data[0]?.fullTimeEmployees != null
        ? Number(data[0].fullTimeEmployees)
        : null;

    employeesCache.set(ticker, { v: employees, t: now });
    return employees;
  } catch {
    employeesCache.set(ticker, { v: null, t: now });
    return null;
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const mode = (searchParams.get("source") || "auto").toLowerCase();
    const marketOpen = isMarketOpenNow();
    const useFmp = mode === "fmp" || (mode !== "alpaca" && marketOpen);

    const fmpRes = await fetch(
      `https://financialmodelingprep.com/api/v3/stock_market/gainers?apikey=${FMP_API_KEY}`,
      { cache: "no-store" }
    );
    if (!fmpRes.ok) throw new Error("Failed to fetch FMP gainers");

    const raw = await fmpRes.json();
    const top20 = (Array.isArray(raw) ? raw : []).slice(0, 15);

    const enriched = await Promise.all(
      top20.map(async (item: any) => {
        const [fundamentals, alpaca, employees] = await Promise.all([
          fetchQuoteFMP(item.symbol),
          fetchQuoteAlpaca(item.symbol),
          fetchEmployeesFMP(item.symbol),
        ]);

        const finalPrice = useFmp ? item.price : alpaca?.price ?? item.price;

        return {
          ticker: item.symbol,
          price: finalPrice,
          changesPercentage: item.changesPercentage,
          marketCap: fundamentals?.marketCap ?? null,
          sharesOutstanding: fundamentals?.sharesOutstanding ?? null,
          volume: alpaca?.volume ?? fundamentals?.volume ?? null,
          employees: employees ?? null,
        };
      })
    );

    return NextResponse.json({
      mode,
      marketOpen,
      sourceUsed: useFmp ? "FMP" : "Alpaca",
      stocks: enriched,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching top gainers:", error);
    return NextResponse.json(
      { errorMessage: "Failed to load top gainers" },
      { status: 500 }
    );
  }
}
