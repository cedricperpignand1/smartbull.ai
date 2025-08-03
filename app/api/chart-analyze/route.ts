import { NextResponse } from "next/server";

const API_KEY = "M0MLRDp8dLak6yJOfdv7joKaKGSje8pp";

// Fetch 30-min candles from FMP
async function fetchCandles(ticker: string) {
  // FMP uses intervals like 1min, 5min, 15min, 30min, 1hour etc.
  // We'll use 30min and get the last 50 candles.
  const url = `https://financialmodelingprep.com/api/v3/historical-chart/30min/${ticker}?apikey=${API_KEY}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`FMP API error: ${res.status}`);
  const data = await res.json();
  return data.slice(0, 50); // most recent 50 candles
}

// Deep analysis function
function analyzeCandles(candles: any[]) {
  if (!candles || candles.length === 0) {
    return {
      bestBuyPrice: "N/A",
      reason: "No 30-minute candles available for analysis.",
    };
  }

  // Convert candles to numeric values (API returns strings)
  const processed = candles.map((c) => ({
    open: parseFloat(c.open),
    close: parseFloat(c.close),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    volume: parseFloat(c.volume),
  }));

  // Compute average closing price
  const avgPrice =
    processed.reduce((sum, c) => sum + c.close, 0) / processed.length;

  // Find support level (lowest low)
  const support = Math.min(...processed.map((c) => c.low));

  // Momentum check: last close - avg price
  const last = processed[0]; // FMP returns latest first
  const momentum = last.close - avgPrice;

  let recommendationPrice = support.toFixed(2);
  let reason = `Analyzed last ${processed.length} candles: Support near ${support.toFixed(
    2
  )}, Moving average ${avgPrice.toFixed(2)}, Last close ${
    last.close
  }. `;

  if (momentum > 0) {
    reason +=
      "Momentum is positive; price above average. Consider entering near the support zone.";
  } else {
    reason +=
      "Momentum is weak; price below average. Best to wait for confirmation but watch support closely.";
  }

  return { bestBuyPrice: recommendationPrice, reason };
}

export async function POST(req: Request) {
  const { ticker } = await req.json();

  try {
    const candles = await fetchCandles(ticker);
    const { bestBuyPrice, reason } = analyzeCandles(candles);

    return NextResponse.json({
      bestBuyPrice,
      reason: `30-min chart analysis for ${ticker}: ${reason}`,
    });
  } catch (error: any) {
    console.error("Chart analysis error:", error);
    return NextResponse.json(
      {
        bestBuyPrice: "N/A",
        reason: `Failed to analyze ${ticker}. ${error.message}`,
      },
      { status: 500 }
    );
  }
}
