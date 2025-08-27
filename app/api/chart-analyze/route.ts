import { NextResponse } from "next/server";

const API_KEY = "M0MLRDp8dLak6yJOfdv7joKaKGSje8pp";

// Fetch 15-min candles from FMP
async function fetchCandles(ticker: string) {
  const url = `https://financialmodelingprep.com/api/v3/historical-chart/15min/${ticker}?apikey=${API_KEY}`;
  const res = await fetch(url, { cache: "no-store" });

  if (!res.ok) throw new Error(`FMP API error: ${res.status}`);
  const data = await res.json();
  return data.slice(0, 50); // most recent 50 candles
}

// Analyze intraday chart data
function analyzeCandles(candles: any[]) {
  if (!candles || candles.length === 0) {
    return {
      bestBuyPrice: "N/A",
      reason: "No 15-minute candles available for analysis.",
      prediction: "unknown",
    };
  }

  const processed = candles.map((c) => ({
    open: parseFloat(c.open),
    close: parseFloat(c.close),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    volume: parseFloat(c.volume),
  }));

  const totalVWAP = processed.reduce(
    (acc, c) => {
      const typicalPrice = (c.high + c.low + c.close) / 3;
      acc.priceVolumeSum += typicalPrice * c.volume;
      acc.totalVolume += c.volume;
      return acc;
    },
    { priceVolumeSum: 0, totalVolume: 0 }
  );
  const vwap = totalVWAP.priceVolumeSum / totalVWAP.totalVolume;

  const highOfDay = Math.max(...processed.map((c) => c.high));
  const lowOfDay = Math.min(...processed.map((c) => c.low));

  const recent = processed.slice(0, 5); // last 5 x 15-min = 75 mins
  const momentumScore = recent[0].close - recent[4].close;

  const last = processed[0];

  let prediction = "neutral";
  if (last.close > vwap && momentumScore > 0) {
    prediction = "likely to go up";
  } else if (last.close < vwap && momentumScore < 0) {
    prediction = "likely to go down";
  }

  let bestBuyPrice = "N/A";
  let reason = `Analyzed ${processed.length} x 15-min candles:\n` +
               `- VWAP: $${vwap.toFixed(2)}\n` +
               `- High of Day: $${highOfDay.toFixed(2)}\n` +
               `- Low of Day: $${lowOfDay.toFixed(2)}\n` +
               `- Last Price: $${last.close.toFixed(2)}\n` +
               `- Momentum (last 5 candles): ${momentumScore.toFixed(2)}.\n`;

  if (momentumScore > 0 && last.close >= vwap) {
    bestBuyPrice = last.close.toFixed(2);
    reason += `Price is trending up and holding above VWAP. Consider buying on pullbacks above VWAP.`;
  } else {
    reason += `Momentum is weak or price is below VWAP. Avoid entry until momentum strengthens or VWAP is reclaimed.`;
  }

  return {
    bestBuyPrice,
    reason,
    prediction,
  };
}

// POST handler
export async function POST(req: Request) {
  try {
    const { ticker } = await req.json();

    if (!ticker || typeof ticker !== "string") {
      return NextResponse.json(
        { error: "Invalid or missing ticker." },
        { status: 400 }
      );
    }

    const candles = await fetchCandles(ticker);
    const result = analyzeCandles(candles);

    return NextResponse.json({
      bestBuyPrice: result.bestBuyPrice,
      reason: `Intraday 15-min analysis for ${ticker.toUpperCase()}:\n\n${result.reason}`,
      prediction: `Next 15 minutes: ${result.prediction}`,
    });
  } catch (error: any) {
    console.error("Chart analysis error:", error.message);
    return NextResponse.json(
      {
        bestBuyPrice: "N/A",
        reason: "Something went wrong during analysis.",
        prediction: "unknown",
      },
      { status: 500 }
    );
  }
}
