// app/api/recommendation/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const FMP_API_KEY = process.env.FMP_API_KEY || "M0MLRDp8dLak6yJOfdv7joKaKGSje8pp";

/* ------------------------- FMP helpers ------------------------- */
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

// Try quote.avgVolume; if missing, compute 30d avg from historical bars
async function fmpAvgVolume(ticker: string): Promise<number | null> {
  try {
    const q = await fmpQuote(ticker);
    const direct =
      num(q?.avgVolume) ?? num(q?.volAvg) ?? num(q?.averageVolume) ?? null;
    if (typeof direct === "number") return direct;
  } catch { /* fallthrough */ }
  try {
    const u = `https://financialmodelingprep.com/api/v3/historical-price-full/${ticker}?serietype=line&timeseries=30&apikey=${FMP_API_KEY}`;
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    const hist = j?.historical;
    if (!Array.isArray(hist) || hist.length === 0) return null;
    let sum = 0, n = 0;
    for (const d of hist) {
      if (typeof d?.volume === "number") { sum += d.volume; n++; }
    }
    return n ? Math.round(sum / n) : null;
  } catch {
    return null;
  }
}

/* --------------------------- utils ---------------------------- */
function quickHeadlineScore(news: any[]): { pos: number; neg: number } {
  const P = ["up","growth","beats","strong","buy","surge","profit","record","raise","approval","upgrade"];
  const N = ["down","miss","weak","cut","lawsuit","probe","loss","warning","downgrade","offering"];
  let pos = 0, neg = 0;
  for (const n of news || []) {
    const t = (n?.title || "").toLowerCase();
    if (!t) continue;
    if (P.some(k => t.includes(k))) pos++;
    if (N.some(k => t.includes(k))) neg++;
  }
  return { pos, neg };
}

const num = (v: any) =>
  v === null || v === undefined || v === "" || Number.isNaN(Number(v))
    ? null
    : Number(v);

// Fallback parser if JSON mode fails; extracts up to two ALLCAP tickers
function parsePicksFromText(txt: string): string[] {
  if (!txt) return [];

  // Try explicit JSON array inside text (no dotAll flag; use [\s\S]*?)
  try {
    // Match: {"picks":[ ... ]}
    const m = txt.match(/\{\s*"picks"\s*:\s*\[([\s\S]*?)\]/i);
    if (m) {
      const arr = JSON.parse(`{"picks":[${m[1]}]}`)?.picks || [];
      return Array.isArray(arr) ? arr.map((s: any) => String(s).toUpperCase()) : [];
    }
  } catch {
    /* ignore */
  }

  // Generic ticker-looking tokens; keep first 2
  const found = Array.from(new Set((txt.toUpperCase().match(/\b[A-Z]{1,5}\b/g) || [])));
  return found.slice(0, 2);
}

/* --------------------------- Route ---------------------------- */
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
    const topN = Math.max(1, Math.min(2, Number(body.topN ?? 2))); // default 2

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

      const dollarVolume = price != null && volume != null ? price * volume : null;
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

    // Enrich each: profile (ETF/OTC), ratios, news, avgVolume (quote or 30d), relVol
    const enriched = await Promise.all(
      base.map(async (row) => {
        const [profile, ratios, news, avgVolRaw, quote] = await Promise.all([
          fmpProfile(row.ticker),
          fmpRatiosTTM(row.ticker),
          fmpNews(row.ticker, 5),
          fmpAvgVolume(row.ticker),
          fmpQuote(row.ticker),
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

    /* ---------------------- HARD FILTERS ---------------------- */
    const filtered = enriched.filter((s) => {
      const passAvgVol    = (s.avgVolume ?? 0) >= 500_000;
      const passRelVol    = (s.relVol ?? 0) >= 3.0;
      const passDollarVol = (s.dollarVolume ?? 0) >= 10_000_000;
      const p = s.price ?? 0;
      const passPrice     = p >= 1 && p <= 50;
      const passVenue     = !s.isEtf && !s.isOTC;
      const passFloat     = (s.sharesOutstanding ?? 0) > 1_999_999; // exclude tiny floats
      return passAvgVol && passRelVol && passDollarVol && passPrice && passVenue && passFloat;
    });

    // If all filtered out, fall back to top-5 by dollar volume so the model still has choices
    const candidates = (filtered.length ? filtered : enriched)
      .slice()
      .sort((a, b) => (b.dollarVolume ?? 0) - (a.dollarVolume ?? 0))
      .slice(0, 5);

    /* -------------------- Prompt (JSON mode) ------------------- */
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

    const system = `
You are a disciplined **intraday** trading assistant selecting up to **two** long candidates to hold **< 1 day**.
Use ONLY the provided data (no outside facts).

## Hard Filters (already enforced server-side)
- AvgVolume ≥ 500,000
- Live Volume ≥ 3 × AvgVolume (RelVol ≥ 3.0)
- Dollar Volume today ≥ $10,000,000
- Price between $1 and $50
- Exclude ETFs/ETNs and OTC
- Float (sharesOutstanding) > 1,999,999

## Primary Signals
- Liquidity/Momentum: higher **DollarVol**, **RelVol (live/avg)**, **RelVolFloat**, healthy **Change %**.
- Spike Potential: prefer **smaller Float (≤ 50M)**, but allow larger floats with very high DollarVol.
- Operational Scale: prefer higher **Employees**; penalize ultra-tiny unless momentum is exceptional.
- Quality: prefer positive/higher **netProfitMarginTTM**.
- Catalysts: positive headlines (beats, upgrade, FDA, guidance). Penalize clusters of negatives.

## Output (strict JSON)
Return a **JSON object** with this exact shape:
{
  "picks": ["TOP1","TOP2"],   // 1 or 2 tickers, ranked best-first
  "reasons": {
    "TOP1": ["bullet","bullet","bullet"],
    "TOP2": ["bullet"]        // optional if second exists
  },
  "risk": "one short sentence on spread/whipsaw/headline risk"
}
Do not invent numbers; cite only provided ones. Keep reasons concise and numeric where possible.
`.trim();

    const user = `
Candidates (numeric fields may be "n/a"):

${lines.join("\n")}

Recent headlines (titles only):
${headlinesBlock}

Select up to **${topN}** best long candidates (ranked). Output JSON as specified.
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
        temperature: 0.15,
        max_tokens: 700,
        response_format: { type: "json_object" as const },
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
    let content: string = data?.choices?.[0]?.message?.content ?? "";
    let modelObj: any = null;
    try {
      modelObj = content ? JSON.parse(content) : null;
    } catch {
      // Fallback: try to salvage picks from text
      const recovered = parsePicksFromText(content);
      modelObj = { picks: recovered, reasons: {}, risk: "" };
    }

    const picksFromModel: string[] = Array.isArray(modelObj?.picks)
      ? modelObj.picks.map((s: any) => String(s).toUpperCase())
      : parsePicksFromText(content);

    // Validate picks against candidates and cap to topN
    const candidateTickers = new Set(candidates.map(c => String(c.ticker).toUpperCase()));
    const validPicks = picksFromModel.filter(p => candidateTickers.has(p)).slice(0, topN);

    // Final safety: ensure at least one pick from candidates if model gave none
    const finalPicks = validPicks.length
      ? validPicks
      : (candidates[0]?.ticker ? [String(candidates[0].ticker).toUpperCase()] : []);

    return NextResponse.json({
      picks: finalPicks,                  // ["TOP1","TOP2?"]
      primary: finalPicks[0] ?? null,     // convenience field
      secondary: finalPicks[1] ?? null,   // convenience field
      reasons: modelObj?.reasons ?? {},
      risk: modelObj?.risk ?? "",
      raw: typeof content === "string" ? content : JSON.stringify(content),
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
