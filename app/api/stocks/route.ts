import { NextResponse } from "next/server";

const FMP_API_KEY = "M0MLRDp8dLak6yJOfdv7joKaKGSje8pp";

const ALPACA_API_KEY = process.env.ALPACA_API_KEY!;
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY!;

// Detect if market is open (Eastern Time 9:30–16:00, Monday to Friday)
function isMarketOpenNow(): boolean {
  const now = new Date();

  // Convert to EST (UTC-5 fixed offset)
  const estOffset = -5;
  const est = new Date(
    now.getTime() + (estOffset * 60 + now.getTimezoneOffset()) * 60000
  );

  const day = est.getDay(); // 0=Sun, 1=Mon, ... 6=Sat
  const h = est.getHours();
  const m = est.getMinutes();

  // Only Monday to Friday
  const isWeekday = day >= 1 && day <= 5;

  // Market hours: 9:30 to 16:00
  const isMarketHours =
    (h > 9 || (h === 9 && m >= 30)) && h < 16;

  return isWeekday && isMarketHours;
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
    const quote = data.quote;

    return {
      price: quote
        ? (quote.bp && quote.ap
            ? (quote.bp + quote.ap) / 2
            : quote.bp || quote.ap)
        : null,
      volume: quote?.s || null,
    };
  } catch (err) {
    console.error(`Alpaca error for ${ticker}`, err);
    return null;
  }
}

async function fetchQuoteFMP(ticker: string) {
  const url = `https://financialmodelingprep.com/api/v3/quote/${ticker}?apikey=${FMP_API_KEY}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const data = await res.json();
  return data.length > 0 ? data[0] : null;
}

async function fetchNews(ticker: string) {
  const url = `https://financialmodelingprep.com/api/v3/stock_news?tickers=${ticker}&limit=5&apikey=${FMP_API_KEY}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  return await res.json();
}

function scoreStock(stock: any, fundamentals: any, alpaca: any, news: any[]) {
  let score = 0;
  const float = fundamentals?.sharesOutstanding || 0;
  const vol = alpaca?.volume || fundamentals?.volume || 0;
  const marketCap = fundamentals?.marketCap || 0;

  if (stock.changesPercentage >= 10) score += 3;
  else if (stock.changesPercentage >= 5) score += 2;
  else score += 1;

  if (float > 0) {
    const relVol = vol / float;
    if (relVol > 0.3) score += 4;
    else if (relVol > 0.1) score += 2;
  }

  if (marketCap > 0 && marketCap < 2_000_000_000) score += 3;
  else if (marketCap > 0 && marketCap < 10_000_000_000) score += 1;

  if (float > 0 && float < 50_000_000) score += 3;
  else if (float > 0 && float < 200_000_000) score += 1;

  const positiveHeadlines = news.filter((n) =>
    n.title.toLowerCase().includes("up") ||
    n.title.toLowerCase().includes("growth") ||
    n.title.toLowerCase().includes("beats") ||
    n.title.toLowerCase().includes("strong") ||
    n.title.toLowerCase().includes("buy") ||
    n.title.toLowerCase().includes("surge")
  ).length;

  score += positiveHeadlines > 0 ? 2 : 0;

  return score;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const override = searchParams.get("source"); // fmp or alpaca
    const marketOpen = isMarketOpenNow();

    // Automatically pick FMP during market hours (9:30-16:00 Mon-Fri)
    const useFmp = override === "fmp" || (marketOpen && override !== "alpaca");

    // Always fetch top gainers from FMP for the base list
    const fmpRes = await fetch(
      `https://financialmodelingprep.com/api/v3/stock_market/gainers?apikey=${FMP_API_KEY}`,
      { cache: "no-store" }
    );
    if (!fmpRes.ok) throw new Error("Failed to fetch FMP gainers");
    const rawData = await fmpRes.json();
    const top20 = rawData.slice(0, 20);

    const analyzed = await Promise.all(
      top20.map(async (item: any) => {
        const fundamentals = await fetchQuoteFMP(item.symbol);
        const alpaca = await fetchQuoteAlpaca(item.symbol);
        const news = await fetchNews(item.symbol);

        const finalPrice = useFmp
          ? item.price
          : alpaca?.price || item.price;

        return {
          ticker: item.symbol,
          price: finalPrice,
          changesPercentage: item.changesPercentage,
          marketCap: fundamentals?.marketCap || null,
          sharesOutstanding: fundamentals?.sharesOutstanding || null,
          volume: alpaca?.volume || fundamentals?.volume || null,
          score: scoreStock(item, fundamentals, alpaca, news),
        };
      })
    );

    const sorted = analyzed.sort((a, b) => b.score - a.score).slice(0, 7);

    return NextResponse.json({
      source: useFmp ? "FMP" : "Alpaca",
      stocks: sorted,
    });
  } catch (error) {
    console.error("Error fetching top gainers:", error);
    return NextResponse.json(
      { errorMessage: "Failed to load top gainers" },
      { status: 500 }
    );
  }
}
