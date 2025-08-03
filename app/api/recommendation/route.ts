import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const stocks = body.gainers || body.stocks; // support both keys

    if (!stocks || !Array.isArray(stocks)) {
      return NextResponse.json(
        { error: "No valid stock data provided" },
        { status: 400 }
      );
    }

    // Format stocks into a text list
    const stockList = stocks
      .map(
        (s: any) =>
          `${s.ticker} - Price: ${s.price}, Change: ${s.changesPercentage.toFixed(
            2
          )}%`
      )
      .join("\n");

    const prompt = `
These are the top 7 gainers today:

${stockList}

From these, which stock would you take a long position trade on, but only hold it for a day or less, focusing on a stock that can move 10% easily? Explain briefly why.
    `;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
      }),
    });

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content || "No recommendation.";

    return NextResponse.json({ recommendation: reply });
  } catch (error) {
    console.error("Error analyzing stocks:", error);
    return NextResponse.json(
      { error: "Failed to analyze stocks" },
      { status: 500 }
    );
  }
}
