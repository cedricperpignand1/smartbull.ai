// app/api/recommendation/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const FMP_API_KEY = process.env.FMP_API_KEY || "M0MLRDp8dLak6yJOfdv7joKaKGSje8pp";

// ---------- FMP helpers ----------
async function fmpProfile(ticker: string) {
  try {
    const u = `https://financialmodelingprep.com/api/v3/profile/${ticker}?apikey=${FMP_API_KEY}`;
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) && j.length ? j[0] : null;
  } catch {
    return null;
  }
}

async function fmpRatiosTTM(ticker: string) {
  try {
    const u = `https://financialmodelingprep.com/api/v3/ratios-ttm/${ticker}?apikey=${FMP_API_KEY}`;
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) && j.length ? j[0] : null;
  } catch {
    return null;
  }
}

async function fmpNews(ticker: string, limit = 5) {
  try {
    const u = `https://financialmodelingprep.com/api/v3/stock_news?tickers=${ticker}&limit=${limit}&apikey=${FMP_API_KEY}`;
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

// Try to read avg volume from quote first; if missing, compute 30d average (daily bars)
async function fmpAvgVolume(ticker: string): Promise<number | null> {
  try {
    const q = await fmpQuote(ticker);
    const direct =
      num(q?.avgVolume) ?? num(q?.volAvg) ?? num(q?.averageVolume) ?? null;
    if (typeof direct === "number") return direct;
  } catch {
    // fallthrough to bars
  }
  try {
    const u = `https://financialmodelingprep.com/api/v3/historical-price-full/${ticker}?serietype=line&timeseries=30&apikey=${FMP_API_KEY}`;
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    const hist = j?.historical;
    if (!Array.isArray(hist) || hist.length === 0) return null;
    let sum = 0,
      n = 0;
    for (const d of hist) {
      if (typeof d?.volume === "number") {
        sum += d.volume;
        n++;
      }
    }
    return n ? Math.round(sum / n) : null;
  } catch {
    return null;
  }
}

async function fmpQuote(ticker: string) {
  try {
    const u = `https://financialmodelingprep.com/api/v3/quote/${ticker}?apikey=${FMP_API_KEY}`;
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) && j.length ? j[0] : null;
  } catch {
    return null;
  }
}

// ---------- utils ----------
function quickHeadlineScore(news: any[]): { pos: number; neg: number } {
  const P = ["up", "growth", "beats", "strong", "buy", "surge", "profit", "record", "raise", "approval", "upgrade"];
  const N = ["down", "miss", "weak", "cut", "lawsuit", "probe", "loss", "warning", "downgrade", "offering"];
  let pos = 0,
    neg = 0;
  for (const n of news || []) {
    const t = (n?.title || "").toLowerCase();
    if (!t) continue;
    if (P.some((k) => t.includes(k))) pos++;
    if (N.some((k) => t.includes(k))) neg++;
  }
  return { pos, neg };
}

const num = (v: any) =>
  v === null || v === undefined || v === "" || Number.isNaN(Number(v))
    ? null
    : Number(v);

// ---------- Route ----------
export async function POST(req: Request) {
  try {
    const key = process.env.OPENAI_API_KEY || "";
    const project = process.env.OPENAI_PROJECT_ID || "";
    const org = process.env.OPENAI_ORGANIZATION_ID || ""; // optional

    if (!key) {
      return NextResponse.json(
        { errorMessage: "OPENAI_API_KEY is not set on the server." },
        { status: 500 }
      );
    }
    if (key.startsWith("sk-proj-") && !project) {
      return NextResponse.json(
        { errorMessage: "OPENAI_PROJECT_ID is required for sk-proj-* keys." },
        { status: 500 }
      );
    }

    const body = await req.json();
    const stocksIn = body.gainers || body.stocks;
    if (!stocksIn || !Array.isArray(stocksIn) || stocksIn.length === 0) {
      return NextResponse.json(
        { errorMessage: "No valid stock data provided to /api/recommendation." },
        { status: 400 }
      );
    }

    // Normalize incoming (top 20)
    const base = stocksIn.slice(0, 20).map((s: any) => {
      const ticker = s.ticker || s.symbol;
      const price = num(s.price);
      const changesPercentage = num(s.changesPercentage);
      const marketCap = num(s.marketCap);
      const sharesOutstanding = num(s.sharesOutstanding ?? s.float ?? s.freeFloat);
      const volume = num(s.volume);
      const employees = num(s.employees ?? s.employeeCount ?? s.fullTimeEmployees);

      const dollarVolume =
        price != null && volume != null ? price * volume : null;
      const relVolFloat =
        volume != null && sharesOutstanding != null && sharesOutstanding > 0
          ? volume / sharesOutstanding
          : null;

      return {
        ticker,
        price,
        changesPercentage,
        marketCap,
        sharesOutstanding,
        volume,
        employees,
        dollarVolume,
        relVolFloat,
      };
    });

    // Enrich each with: profile (ETF/OTC check), ratios, news, avgVolume (quote or 30d bars), relVol
    const enriched = await Promise.all(
      base.map(async (row) => {
        const [profile, ratios, news, avgVolRaw, quote] = await Promise.all([
          fmpProfile(row.ticker),
          fmpRatiosTTM(row.ticker),
          fmpNews(row.ticker, 5),
          fmpAvgVolume(row.ticker),
          fmpQuote(row.ticker), // also to fallback missing fields
        ]);

        const isEtf =
          profile?.isEtf === true ||
          /ETF|ETN/i.test(profile?.companyName || "") ||
          /ETF|ETN/i.test(profile?.industry || "");
        const isOTC =
          String(profile?.exchangeShortName || "").toUpperCase() === "OTC";

        const employees =
          row.employees != null ? row.employees : num(profile?.fullTimeEmployees);
        const marketCap =
          row.marketCap != null ? row.marketCap : num(profile?.mktCap);

        const profitMarginTTM =
          num(ratios?.netProfitMarginTTM) ?? num(profile?.netProfitMarginTTM) ?? null;

        const avgVolume = num(avgVolRaw);
        const relVol =
          row.volume != null && avgVolume != null && avgVolume > 0
            ? row.volume / avgVolume
            : null;

        const price = row.price ?? num(quote?.price);

        const { pos, neg } = quickHeadlineScore(news);

        return {
          ...row,
          price,
          marketCap,
          employees,
          profitMarginTTM,
          avgVolume,
          relVol,
          isEtf,
          isOTC,
          sector: profile?.sector || null,
          industry: profile?.industry || null,
          headlines: (news || []).map((n: any) => n?.title).filter(Boolean).slice(0, 5),
          headlinePos: pos,
          headlineNeg: neg,
        };
      })
    );

    // ---------- HARD FILTERS ----------
    const filtered = enriched.filter((s) => {
      const passAvgVol = (s.avgVolume ?? 0) >= 500_000;
      const passRelVol = (s.relVol ?? 0) >= 3.0;
      const passDollarVol = (s.dollarVolume ?? 0) >= 10_000_000;
      const p = s.price ?? 0;
      const passPrice = p >= 1 && p <= 50;
      const passVenue = !s.isEtf && !s.isOTC;
      return passAvgVol && passRelVol && passDollarVol && passPrice && passVenue;
    });

    // If everything filtered out, fall back to the best few by dollar volume so the model can still pick
    const candidates = filtered.length ? filtered : enriched
      .slice()
      .sort((a, b) => (b.dollarVolume ?? 0) - (a.dollarVolume ?? 0))
      .slice(0, 5);

    // ---------- Build compact lines for the model ----------
    const lines = candidates.map((s) => {
      const pct =
        s.changesPercentage == null
          ? "n/a"
          : Math.abs(s.changesPercentage) <= 1
          ? (s.changesPercentage * 100).toFixed(2) + "%"
          : s.changesPercentage.toFixed(2) + "%";
      return [
        s.ticker,
        `Price:${s.price ?? "n/a"}`,
        `Change:${pct}`,
        `MktCap:${s.marketCap ?? "n/a"}`,
        `Float:${s.sharesOutstanding ?? "n/a"}`,
        `Vol:${s.volume ?? "n/a"}`,
        `AvgVol:${s.avgVolume ?? "n/a"}`,
        `RelVol(live/avg):${s.relVol != null ? s.relVol.toFixed(2) + "x" : "n/a"}`,
        `RelVolFloat:${s.relVolFloat != null ? s.relVolFloat.toFixed(3) + "x" : "n/a"}`,
        `DollarVol:${s.dollarVolume != null ? Math.round(s.dollarVolume).toLocaleString() : "n/a"}`,
        `Employees:${s.employees ?? "n/a"}`,
        `ProfitMarginTTM:${s.profitMarginTTM != null ? (Math.abs(s.profitMarginTTM) <= 1 ? (s.profitMarginTTM*100).toFixed(2) : s.profitMarginTTM.toFixed(2)) + "%" : "n/a"}`,
        `Sector:${s.sector ?? "n/a"}`,
        `Industry:${s.industry ?? "n/a"}`,
        `Headlines(+/-):${s.headlinePos}/${s.headlineNeg}`,
      ].join(" | ");
    });

    const headlinesBlock = candidates
      .map(
        (s) =>
          `### ${s.ticker}\n- ${s.headlines?.join("\n- ") || "(no recent headlines)"}`
      )
      .join("\n\n");

    // ---------- Prompt with hard filters ----------
    const system = `
You are a disciplined **intraday** trading assistant selecting ONE long trade to hold **less than one day**.
Use ONLY the provided data (no outside facts).

## Hard Filters (must pass ALL; already applied server-side)
1) AvgVolume ≥ 500,000
2) Live Volume ≥ 3 × AvgVolume (RelVol ≥ 3.0)
3) Dollar Volume today ≥ $10,000,000
4) Price between $1 and $50
5) Exclude ETFs/ETNs and OTC

## Primary Signals
- Momentum/Liquidity: higher **DollarVol**, **RelVol (live/avg)**, **RelVolFloat**, healthy **Change %**.
- Spike Potential: prefer **smaller Float (≤ 50M)**; allow larger floats only with very high DollarVol.
- Quality: prefer positive/higher **netProfitMarginTTM**; avoid obvious shells (extremely tiny employees) unless momentum is exceptional.
- Catalysts: today’s positive headlines (beats, upgrade, deal, FDA, strong guidance) support the long; many negatives warn.

## Output (concise & numeric)
- **Pick:** <TICKER>
- **Why (bullets):** 3–5 bullets citing **DollarVol**, **RelVol (live/avg)**, **RelVolFloat**, **Float**, **MktCap**, **ProfitMarginTTM**, **Headlines sentiment** (with the actual numbers you used).
- **Second choice (optional):** <TICKER> + 1 bullet.
- **Risk note:** one short line (spread, whipsaw, headline risk).
Do not invent numbers. If fields are missing, acknowledge and use available signals.
`.trim();

    const user = `
Candidates (numeric fields may be "n/a"):

${lines.join("\n")}

Recent headlines (titles only):
${headlinesBlock}

Pick the **single best** long candidate for a <1 day hold that can plausibly move ~10% with sufficient liquidity. Cite actual numbers.
`.trim();

    // ---------- OpenAI call ----------
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    };
    if (key.startsWith("sk-proj-")) headers["OpenAI-Project"] = project;
    if (org) headers["OpenAI-Organization"] = org;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        max_tokens: 550,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("OpenAI error:", res.status, errText);
      return NextResponse.json(
        { errorMessage: `OpenAI API error ${res.status}: ${errText || "Unknown error"}` },
        { status: 500 }
      );
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      console.error("OpenAI empty response:", JSON.stringify(data, null, 2));
      return NextResponse.json(
        { errorMessage: "OpenAI returned no message content." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      recommendation: reply,
      context: {
        tickers: candidates.map((x) => ({
          ticker: x.ticker,
          price: x.price,
          changesPercentage: x.changesPercentage,
          marketCap: x.marketCap,
          sharesOutstanding: x.sharesOutstanding,
          volume: x.volume,
          avgVolume: x.avgVolume,
          relVol: x.relVol,
          relVolFloat: x.relVolFloat,
          dollarVolume: x.dollarVolume,
          employees: x.employees,
          profitMarginTTM: x.profitMarginTTM,
          headlinePos: x.headlinePos,
          headlineNeg: x.headlineNeg,
        })),
      },
    });
  } catch (error: any) {
    console.error("Recommendation route error:", error);
    return NextResponse.json(
      { errorMessage: error?.message || "Failed to analyze stocks" },
      { status: 500 }
    );
  }
}
