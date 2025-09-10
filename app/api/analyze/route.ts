import { NextResponse } from "next/server";

const API_KEY = "M0MLRDp8dLak6yJOfdv7joKaKGSje8pp";

async function fetchNews(ticker: string) {
  const url = `https://financialmodelingprep.com/api/v3/stock_news?tickers=${ticker}&limit=5&apikey=${API_KEY}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  return await res.json();
}

function scoreStock(stock: any, news: any[]) {
  let score = 0;

  const change = stock.changesPercentage || 0;
  const sharesOutstanding = stock.sharesOutstanding || 0;
  const marketCap = stock.marketCap || 0;
  const volume = stock.volume || 0;

  // Strong % gain
  if (change >= 10) score += 3;
  else if (change >= 5) score += 2;
  else score += 1;

  // Smaller float = more volatility
  if (sharesOutstanding > 0 && sharesOutstanding < 50_000_000) score += 4;
  else if (sharesOutstanding > 0 && sharesOutstanding < 200_000_000) score += 2;

  // Market cap preference
  if (marketCap > 0 && marketCap < 2_000_000_000) score += 3;
  else if (marketCap > 0 && marketCap < 10_000_000_000) score += 1;

  // High volume = more momentum
  if (volume > 5_000_000) score += 2;
  if (volume > 20_000_000) score += 3;

  // News sentiment boost
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

export async function POST(req: Request) {
  const { stocks } = await req.json();

  if (!stocks || stocks.length === 0) {
    return NextResponse.json({
      recommendation: "No stocks available for analysis.",
    });
  }

  let bestStock: any = null;
  let bestNews: any[] = [];
  let bestScore = -Infinity;

  for (const stock of stocks) {
    try {
      // 🚫 Skip if volume under 500K
      if (!stock.volume || stock.volume < 500_000) {
        continue;
      }

      const news = await fetchNews(stock.ticker);
      const score = scoreStock(stock, news);

      if (score > bestScore) {
        bestScore = score;
        bestStock = stock;
        bestNews = news;
      }
    } catch (err) {
      console.error(`Error analyzing ${stock.ticker}:`, err);
    }
  }

  if (!bestStock) {
    return NextResponse.json({
      recommendation: "No stocks met the minimum 500K volume requirement.",
    });
  }

  const explanation = `Based on today's data, the best stock for a potential 10% intraday trade is **${bestStock.ticker}**.

Key metrics:
- Price: $${bestStock.price}
- % Change: ${bestStock.changesPercentage.toFixed(2)}%
- Volume (today): ${bestStock.volume?.toLocaleString() || "N/A"}
- Market Cap: ${bestStock.marketCap ? "$" + bestStock.marketCap.toLocaleString() : "N/A"}
- Shares Outstanding (Float): ${bestStock.sharesOutstanding?.toLocaleString() || "N/A"}

Reasoning:
- Significant intraday % gain shows strong momentum.
- High volume indicates strong market interest.
- Market cap and float suggest this stock can still move quickly.

Recent headlines:
${bestNews.length > 0
    ? bestNews.map((n: any, i: number) => `(${i + 1}) ${n.title}`).join("\n")
    : "No significant recent headlines found."}

This stock shows strong characteristics for another 10% move today if momentum continues.`;

  return NextResponse.json({ recommendation: explanation });
}
