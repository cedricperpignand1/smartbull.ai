// Streaming narration (SSE-like plain text stream)
import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function POST(req: Request) {
  const { symbol, price, float, relVol, thesis } = await req.json();

  const sys = `You are an intraday trading coach. 
Explain clearly what you're analyzing and why.
Output ~180–240 words with:
- Setup & catalyst
- Entry plan (levels/timing)
- Risk (stop/size)
- Targets & management
- Exit rules (profit/invalidation)
- One-liner if no-trade.`;

  const user = `Symbol: ${symbol}
Price: ${price ?? "n/a"}
Float: ${float ?? "n/a"}
RelVol: ${relVol ?? "n/a"}
Notes: ${thesis ?? "none"}
Constraints:
- Use concrete levels (premarket H/L, whole/half dollars, VWAP).
- Keep it actionable and realistic.`;

  const stream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    stream: true,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
  });

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content || "";
          if (delta) controller.enqueue(new TextEncoder().encode(delta));
        }
      } catch (e) {
        controller.enqueue(new TextEncoder().encode("\n[Stream error]\n"));
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
