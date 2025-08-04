import { NextResponse } from "next/server";

const FMP_API_KEY = process.env.FMP_API_KEY || "M0MLRDp8dLak6yJOfdv7joKaKGSje8pp";

// ---- FMP helpers ------------------------------------------------------------
async function fmpProfile(ticker: string) {
  try {
    const u = `https://financialmodelingprep.com/api/v3/profile/${ticker}?apikey=${FMP_API_KEY}`;
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data) && data.length ? data[0] : null;
  } catch {
    return null;
  }
}

async function fmpRatiosTTM(ticker: string) {
  try {
    const u = `https://financialmodelingprep.com/api/v3/ratios-ttm/${ticker}?apikey=${FMP_API_KEY}`;
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) return null;
    const data = await r.json();
    // FMP returns an array; we take the most recent if present
    return Array.isArray(data) && data.length ? data[0] : null;
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

// quick headline sentiment (very basic)
function quickHeadlineScore(news: any[]): { pos: number; neg: number } {
  const P = ["up", "growth", "beats", "strong", "buy", "surge", "profit", "record", "raise"];
  const N = ["down", "miss", "weak", "cut", "lawsuit", "probe", "loss", "warning"];
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

// safe number formatter
const num = (v: any) =>
  v === null || v === undefined || v === "" || Number.isNaN(Number(v))
    ? null
    : Number(v);

// ---- Route -----------------------------------------------------------------
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

    // Normalize the 7 items from the UI
    const base = stocksIn.slice(0, 7).map((s: any) => {
      const ticker = s.ticker || s.symbol;
      const price = num(s.price);
      const changesPercentage = num(s.changesPercentage);
      const marketCap = num(s.marketCap);
      const sharesOutstanding = num(s.sharesOutstanding ?? s.float ?? s.freeFloat);
      const volume = num(s.volume);
      const employees = num(s.employees ?? s.employeeCount ?? s.fullTimeEmployees);

      // Derived
      const relVolFloat =
        volume != null && sharesOutstanding != null && sharesOutstanding > 0
          ? volume / sharesOutstanding
          : null;
      const dollarVolume =
        price != null && volume != null ? price * volume : null;
      const floatDollar =
        price != null && sharesOutstanding != null ? price * sharesOutstanding : null;

      return {
        ticker,
        price,
        changesPercentage,
        marketCap,
        sharesOutstanding,
        volume,
        employees,
        relVolFloat,
        dollarVolume,
        floatDollar,
      };
    });

    // Enrich with FMP: profile, ratios (profitability), and latest headlines
    const enriched = await Promise.all(
      base.map(async (row) => {
        const [profile, ratios, news] = await Promise.all([
          fmpProfile(row.ticker),
          fmpRatiosTTM(row.ticker),
          fmpNews(row.ticker, 5),
        ]);

        // prefer API/DB values if missing on input
        const employees =
          row.employees != null
            ? row.employees
            : num(profile?.fullTimeEmployees);

        // profit margin from ratios; fallback to profile's netProfitMarginTTM if present
        const profitMarginTTM =
          num(ratios?.netProfitMarginTTM) ??
          num(profile?.netProfitMarginTTM) ??
          null;

        // sometimes marketCap can be missing in your input—fallback to profile
        const marketCap =
          row.marketCap != null ? row.marketCap : num(profile?.mktCap);

        const { pos, neg } = quickHeadlineScore(news);

        return {
          ...row,
          sector: profile?.sector || null,
          industry: profile?.industry || null,
          employees,
          marketCap,
          profitMarginTTM,
          headlines: (news || []).map((n: any) => n?.title).filter(Boolean).slice(0, 5),
          headlinePos: pos,
          headlineNeg: neg,
        };
      })
    );

    // Build compact lines for the model
    const lines = enriched.map((s) => {
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
        `RelVolFloat:${s.relVolFloat != null ? s.relVolFloat.toFixed(3) + "x" : "n/a"}`,
        `DollarVol:${s.dollarVolume != null ? Math.round(s.dollarVolume).toLocaleString() : "n/a"}`,
        `FloatDollar:${s.floatDollar != null ? Math.round(s.floatDollar).toLocaleString() : "n/a"}`,
        `Employees:${s.employees ?? "n/a"}`,
        `ProfitMarginTTM:${s.profitMarginTTM != null ? (Math.abs(s.profitMarginTTM) <= 1 ? (s.profitMarginTTM*100).toFixed(2) : s.profitMarginTTM.toFixed(2)) + "%" : "n/a"}`,
        `Sector:${s.sector ?? "n/a"}`,
        `Industry:${s.industry ?? "n/a"}`,
        `Headlines(+/-):${s.headlinePos}/${s.headlineNeg}`,
      ].join(" | ");
    });

    // Include recent headlines as context (titles only to keep tokens in check)
    const headlinesBlock = enriched
      .map(
        (s) =>
          `### ${s.ticker}\n- ${s.headlines?.join("\n- ") || "(no recent headlines)"}`
      )
      .join("\n\n");

    // System prompt: aggressive but disciplined intraday criteria
    const system = `
You are a disciplined **intraday** trading assistant selecting ONE long trade to hold **less than one day**.

Use ALL provided, *grounded* data only (no outside facts):
- Momentum/Liquidity: Change %, **Dollar Volume**, **RelVolFloat** (volume/float).
- Size: **Market Cap**, **Float (sharesOutstanding)**, **Employees** (scale).
- Profitability: **netProfitMarginTTM** (prefer positive/higher).
- Catalysts: **Latest headline titles** with quick sentiment (+/- counts).
- Sector/Industry (for context only).

Goal: pick a name that can **realistically move ~10% intraday** with **adequate liquidity** and **reasonable risk**.

Heuristics:
1) Prefer **higher Dollar Volume** (easy entries/exits) and **RelVolFloat ≥ ~0.1x** (or higher).
2) **Smaller float** names tend to move more; avoid illiquid micro-caps with negligible volume/dollar volume.
3) When momentum/liquidity are similar, prefer companies with **positive profitability** and **non-tiny headcount** (not a shell). Extremely tiny orgs can be fragile; mega-caps usually move less.
4) Use headlines as a tiebreaker: recent positive catalysts (beats, upgrade, surge) support a long idea; many negatives are a warning.
5) If some fields are missing, acknowledge uncertainty and decide from available signals.

Return a short, structured answer:
- **Pick:** <TICKER>
- **Why (bullets):** 3–5 bullets citing **DollarVol**, **RelVolFloat**, **Float**, **MktCap**, **ProfitMarginTTM**, **Employees**, and **Headlines sentiment** (as applicable, with the actual numbers you used).
- **Second choice (optional):** <TICKER> + 1 bullet.
- **Risk note:** one short line (thin liquidity, headline risk, etc.).
Be concise and numeric. Do not invent numbers.`;

    const user = `
Seven top gainers (numeric fields may be "n/a"):

${lines.join("\n")}

Recent headlines (titles only):
${headlinesBlock}

Pick the **single best** long candidate for a <1 day hold that can plausibly move ~10% with sufficient liquidity. Follow the rules above and cite the **actual numbers** you used.
`.trim();

    // OpenAI call
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

    // Optionally return the enriched context for debugging/inspection
    return NextResponse.json({
      recommendation: reply,
      context: {
        tickers: enriched.map((x) => ({
          ticker: x.ticker,
          price: x.price,
          changesPercentage: x.changesPercentage,
          marketCap: x.marketCap,
          sharesOutstanding: x.sharesOutstanding,
          volume: x.volume,
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
