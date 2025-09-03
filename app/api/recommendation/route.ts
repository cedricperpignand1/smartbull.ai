// app/api/recommendation/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// ⬇️ use the cached FMP helpers (relative import avoids alias issues)
import {
  fmpProfileCached,
  fmpRatiosTTMCached,
  fmpNewsCached,
  fmpQuoteCached,
  fmpAvgVolumeSmartCached,
} from "../../../lib/fmpCached";

export const runtime = "nodejs";

/* ──────────────────────────────────────────────────────────
   Config
   ────────────────────────────────────────────────────────── */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_PROJECT_ID = process.env.OPENAI_PROJECT_ID || "";
const OPENAI_ORG = process.env.OPENAI_ORGANIZATION_ID || "";

// Alpaca (free IEX feed works for premarket with these keys)
const ALPACA_KEY = process.env.ALPACA_KEY || process.env.ALPACA_API_KEY || "";
const ALPACA_SECRET = process.env.ALPACA_SECRET || process.env.ALPACA_API_SECRET || "";

/* ──────────────────────────────────────────────────────────
   Limits to control API usage
   ────────────────────────────────────────────────────────── */
const MAX_INPUT = 20;        // read at most 20 incoming rows
const FMP_ENRICH_LIMIT = 6;  // ⬅️ reduced to cut rate usage
const PREMARKET_LIMIT = 8;   // analyze premarket for top 8 (single Alpaca call)

// Premarket+open window you want the model to consider
const PM_START_H = 9, PM_START_M = 0;
const PM_END_H   = 9, PM_END_M   = 45;

// Optional: global toggle to disable PM fetch without redeploy
const PM_ENABLED = (process.env.RECOMMENDATION_PM_ENABLED ?? "true").toLowerCase() !== "false";

/* ──────────────────────────────────────────────────────────
   Utils (time, numbers)
   ────────────────────────────────────────────────────────── */
const num = (v: any) =>
  v === null || v === undefined || v === "" || Number.isNaN(Number(v))
    ? null
    : Number(v);

function nowET(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}
function yyyyMmDdET(): string {
  const d = nowET();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}
function isWeekdayET(): boolean {
  const d = nowET().getDay();
  return d >= 1 && d <= 5; // Mon–Fri
}
function isAfterOrAt(h: number, m: number) {
  const d = nowET();
  const hh = d.getHours(), mm = d.getMinutes();
  return (hh > h) || (hh === h && mm >= m);
}
function isBefore(h: number, m: number) {
  const d = nowET();
  const hh = d.getHours(), mm = d.getMinutes();
  return (hh < h) || (hh === h && mm < m);
}
// Build ISO timestamp at a specific ET wall-clock time (e.g., 09:00 ET)
function isoAtEtTime(h: number, m: number): string {
  const d = nowET();
  d.setHours(h, m, 0, 0);
  const tz = Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(d);
  const get = (t: string) => tz.find(p => p.type === t)?.value || "";
  const y = get("year");
  const mo = get("month");
  const da = get("day");
  const hh = get("hour");
  const mm = get("minute");
  const ss = get("second");
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  const et  = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const offMin = Math.round((et.getTime() - utc.getTime()) / 60000);
  const sign = offMin >= 0 ? "+" : "-";
  const offAbs = Math.abs(offMin);
  const offHH = String(Math.floor(offAbs / 60)).padStart(2, "0");
  const offMM = String(offAbs % 60).padStart(2, "0");
  return `${y}-${mo}-${da}T${hh}:${mm}:${ss}${sign}${offHH}:${offMM}`;
}
// min(nowET, target ET time as ISO)
function isoEndCapTo(h: number, m: number): string {
  const cap = nowET();
  const target = nowET();
  target.setHours(h, m, 0, 0);
  const use = cap.getTime() < target.getTime() ? cap : target;
  return isoAtEtTime(use.getHours(), use.getMinutes());
}

/* ──────────────────────────────────────────────────────────
   Premarket helpers (Alpaca) with caching
   ────────────────────────────────────────────────────────── */
type PMetrics = {
  pmHigh?: number | null;
  pmLow?: number | null;
  pmRangePct?: number | null; // (high-low)/((high+low)/2)
  pmVolume?: number | null;
  pmVWAP?: number | null;
  pmUpMinutePct?: number | null; // % of minutes close>open
  pmScore?: number | null; // compact composite
};

// Simple in-memory cache (resets on server cold start)
let pmCacheDate: string | null = null;
let pmCache: Record<string, PMetrics> = {};
let pmCacheWindow: string | null = null; // e.g., "09:00–09:45"
let pmCacheEndISO: string | null = null; // actual end used (e.g., 09:23 before cap)
let pmLastFetchMs = 0;
const PM_FETCH_THROTTLE_MS = 2 * 60 * 1000; // 2 minutes

async function fetchBarsWindow(symbols: string[], startISO: string, endISO: string) {
  const out: Record<string, PMetrics> = {};
  for (const s of symbols) out[s] = {};
  if (!ALPACA_KEY || !ALPACA_SECRET || symbols.length === 0) return out;

  const u = new URL("https://data.alpaca.markets/v2/stocks/bars");
  u.searchParams.set("symbols", symbols.join(","));
  u.searchParams.set("timeframe", "1Min");
  u.searchParams.set("start", startISO);
  u.searchParams.set("end", endISO);
  u.searchParams.set("adjustment", "raw");
  u.searchParams.set("feed", "iex");
  u.searchParams.set("limit", "1000");

  const r = await fetch(u.toString(), {
    headers: {
      "APCA-API-KEY-ID": ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
    },
    cache: "no-store",
  });
  if (!r.ok) return out;
  const j = await r.json();

  let bySymbol: Record<string, any[]> = {};
  if (j?.bars && typeof j.bars === "object" && !Array.isArray(j.bars)) {
    bySymbol = j.bars;
  } else if (Array.isArray(j?.bars)) {
    for (const b of j.bars) {
      const sym = (b?.S || b?.Symbol || b?.symbol || "").toUpperCase();
      if (!sym) continue;
      (bySymbol[sym] ||= []).push(b);
    }
  }

  for (const sym of symbols) {
    const bars: any[] = bySymbol[sym] || [];
    if (!bars.length) continue;

    let hi = -Infinity, lo = Infinity;
    let volSum = 0;
    let vwapNum = 0;
    let upCount = 0;
    let n = 0;

    for (const b of bars) {
      const o = num(b.o ?? b.open);
      const h = num(b.h ?? b.high);
      const l = num(b.l ?? b.low);
      const c = num(b.c ?? b.close);
      const v = num(b.v ?? b.volume) || 0;

      if (h != null && h > hi) hi = h;
      if (l != null && l < lo) lo = l;
      volSum += v;
      const px = (h != null && l != null) ? (h + l) / 2 : (c ?? o ?? null);
      if (px != null) vwapNum += px * v;

      if (o != null && c != null && c > o) upCount++;
      n++;
    }

    const pmHigh = isFinite(hi) ? hi : null;
    const pmLow = isFinite(lo) ? lo : null;
    const mid = (pmHigh != null && pmLow != null) ? (pmHigh + pmLow) / 2 : null;
    const pmRangePct = (pmHigh != null && pmLow != null && mid && mid > 0)
      ? (pmHigh - pmLow) / mid
      : null;
    const pmVolume = volSum || null;
    const pmVWAP = volSum > 0 ? vwapNum / volSum : null;
    const pmUpMinutePct = n > 0 ? (upCount / n) : null;

    out[sym] = { pmHigh, pmLow, pmRangePct, pmVolume, pmVWAP, pmUpMinutePct };
  }

  // Build normalized pmScore across this batch
  const arr = symbols.map(s => ({
    s,
    vol: out[s]?.pmVolume ?? null,
    rng: out[s]?.pmRangePct ?? null,
    up:  out[s]?.pmUpMinutePct ?? null
  }));
  const nz = <T extends number>(x: T | null) => (x == null || !Number.isFinite(x)) ? null : x;

  function norm(key: "vol" | "rng" | "up") {
    const vals = arr.map(a => nz(a[key])).filter((v): v is number => v != null);
    if (!vals.length) return (_: number | null) => null;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    if (max - min < 1e-12) return (_: number | null) => 0.5;
    return (x: number | null) => (x == null ? null : (x - min) / (max - min));
    }
  const nVol = norm("vol"), nRng = norm("rng"), nUp = norm("up");

  for (const s of symbols) {
    const v = nVol(out[s]?.pmVolume ?? null);
    const r = nRng(out[s]?.pmRangePct ?? null);
    const u = nUp(out[s]?.pmUpMinutePct ?? null);
    const parts = [v, r, u].filter((x): x is number => x != null);
    const score = parts.length
      ? ( (v ?? 0)*0.4 + (r ?? 0)*0.4 + (u ?? 0)*0.2 )
      : null;
    out[s].pmScore = score;
  }

  return out;
}

// Get or fetch the 09:00–09:45 snapshot with caching/throttling
async function getOrFetchPremarket(symbols: string[]) {
  const out: Record<string, PMetrics> = {};
  for (const s of symbols) out[s] = {};

  if (!PM_ENABLED) return { bySym: out, skipped: "pm_disabled" };
  if (!ALPACA_KEY || !ALPACA_SECRET) return { bySym: out, skipped: "missing_alpaca_credentials" };
  if (!isWeekdayET()) return { bySym: out, skipped: "not_weekday" };

  const today = yyyyMmDdET();
  const startISO = isoAtEtTime(PM_START_H, PM_START_M);
  const endISO   = isoEndCapTo(PM_END_H, PM_END_M); // min(now, 09:45)

  // Reset cache on new day
  const needReset = pmCacheDate !== today;
  if (needReset) {
    pmCacheDate = today;
    pmCache = {};
    pmCacheWindow = null;
    pmCacheEndISO = null;
    pmLastFetchMs = 0;
  }

  // After 09:45, if we already have a full snapshot → reuse
  const nowAfter945 = isAfterOrAt(PM_END_H, PM_END_M);
  const nowBefore9  = isBefore(PM_START_H, PM_START_M);

  if (nowBefore9) {
    return { bySym: out, skipped: "before_09_00_ET" };
  }

  if (nowAfter945 && pmCacheDate === today && pmCacheEndISO) {
    return { bySym: symbols.reduce((acc, s) => { acc[s] = pmCache[s] || {}; return acc; }, {} as Record<string, PMetrics>), skipped: null };
  }

  // Throttle refetches while between 09:00 and 09:45
  const nowMs = Date.now();
  if (!nowAfter945 && pmLastFetchMs && (nowMs - pmLastFetchMs) < PM_FETCH_THROTTLE_MS) {
    return { bySym: symbols.reduce((acc, s) => { acc[s] = pmCache[s] || {}; return acc; }, {} as Record<string, PMetrics>), skipped: null };
  }

  // Fetch the current partial window (09:00 → min(now, 09:45))
  const fresh = await fetchBarsWindow(symbols, startISO, endISO);

  // Merge into cache
  for (const s of symbols) {
    pmCache[s] = fresh[s] || pmCache[s] || {};
  }
  pmCacheWindow = "09:00–09:45";
  pmCacheEndISO = endISO; // note: before 09:45 this is a moving cap
  pmLastFetchMs = nowMs;

  return { bySym: symbols.reduce((acc, s) => { acc[s] = pmCache[s] || {}; return acc; }, {} as Record<string, PMetrics>), skipped: null };
}

/* ──────────────────────────────────────────────────────────
   Headline scoring
   ────────────────────────────────────────────────────────── */
function quickHeadlineScore(news: any[]): { pos: number; neg: number } {
  const P = ["up","growth","beats","strong","buy","surge","profit","record","raise","approval","upgrade","guidance"];
  const N = ["down","miss","weak","cut","lawsuit","probe","loss","warning","downgrade","offering","sec","investigation"];
  let pos = 0, neg = 0;
  for (const n of news || []) {
    const t = (n?.title || "").toLowerCase();
    if (!t) continue;
    if (P.some(k => t.includes(k))) pos++;
    if (N.some(k => t.includes(k))) neg++;
  }
  return { pos, neg };
}

/* Extract picks if JSON parsing fails */
function parsePicksFromText(txt: string): string[] {
  if (!txt) return [];
  try {
    const m = txt.match(/\{\s*"picks"\s*:\s*\[([\s\S]*?)\]/i);
    if (m) {
      const arr = JSON.parse(`{"picks":[${m[1]}]}`)?.picks || [];
      return Array.isArray(arr) ? arr.map((s: any) => String(s).toUpperCase()) : [];
    }
  } catch { /* ignore */ }
  const found = Array.from(new Set((txt.toUpperCase().match(/\b[A-Z]{1,5}\b/g) || [])));
  return found.slice(0, 2);
}

/* Build explanation that includes PM bullets when available */
function buildExplanationForPick(
  t: string,
  c: {
    relVol?: number | null;
    dollarVolume?: number | null;
    sharesOutstanding?: number | null;
    employees?: number | null;
    profitMarginTTM?: number | null;
    headlinePos?: number;
    headlineNeg?: number;
    pmHigh?: number | null;
    pmLow?: number | null;
    pmRangePct?: number | null;
    pmVolume?: number | null;
    pmVWAP?: number | null;
    pmUpMinutePct?: number | null;
  } | undefined,
  reasons: string[] | undefined,
  risk: string | undefined
): string {
  const bullets: string[] = [];
  if (reasons?.length) bullets.push(...reasons);
  if (c?.relVol != null) bullets.push(`RelVol ~ ${c.relVol.toFixed(2)}x`);
  if (c?.dollarVolume != null) bullets.push(`DollarVol ~$${Math.round(c.dollarVolume).toLocaleString()}`);
  if (c?.sharesOutstanding != null) bullets.push(`Float ~ ${c.sharesOutstanding.toLocaleString()}`);
  if (c?.employees != null) bullets.push(`Employees ~ ${c.employees.toLocaleString()}`);
  if (c?.profitMarginTTM != null) {
    const pm = Math.abs(c.profitMarginTTM) <= 1 ? (c.profitMarginTTM * 100).toFixed(1) : c.profitMarginTTM.toFixed(1);
    bullets.push(`ProfitMarginTTM ${pm}%`);
  }
  if (c?.headlinePos != null && c?.headlineNeg != null) bullets.push(`Headlines +${c.headlinePos}/-${c.headlineNeg}`);
  if (c?.pmRangePct != null) bullets.push(`09:00–09:45 range ${(c.pmRangePct*100).toFixed(1)}%`);
  if (c?.pmVolume != null) bullets.push(`09:00–09:45 vol ${Math.round(c.pmVolume).toLocaleString()}`);
  if (c?.pmVWAP != null) bullets.push(`09:00–09:45 VWAP ~$${c.pmVWAP.toFixed(2)}`);
  if (c?.pmUpMinutePct != null) bullets.push(`Up-minutes ${(c.pmUpMinutePct*100).toFixed(0)}%`);
  if (risk?.trim()) bullets.push(`Risk: ${risk.trim()}`);
  const clean = bullets.map(b => b.replace(/\s+/g, " ").trim()).filter(Boolean);
  return clean.length ? clean.join(" • ") : `${t.toUpperCase()} selected for momentum, liquidity & morning tone.`;
}

/* ──────────────────────────────────────────────────────────
   Soft preference helpers (Float ↓ strongest, Employees ↑, AvgVolume ↑)
   ────────────────────────────────────────────────────────── */
// NEW: prefer smaller float most; employees still matters (log-scaled); avg volume modest.
function buildSoftPrefScorer(rows: Array<{ sharesOutstanding?: number|null; employees?: number|null; avgVolume?: number|null }>) {
  const floats = rows.map(r => r.sharesOutstanding ?? null).filter((v): v is number => v != null && Number.isFinite(v));
  const emps   = rows.map(r => r.employees ?? null).filter((v): v is number => v != null && Number.isFinite(v));
  const avgs   = rows.map(r => r.avgVolume ?? null).filter((v): v is number => v != null && Number.isFinite(v));

  const fMin = floats.length ? Math.min(...floats) : null;
  const fMax = floats.length ? Math.max(...floats) : null;

  // log-scale employees to avoid Macy's-type domination
  const log = (x: number) => Math.log10(Math.max(1, x));
  const eLogs = emps.map(log);
  const eMin = eLogs.length ? Math.min(...eLogs) : null;
  const eMax = eLogs.length ? Math.max(...eLogs) : null;

  const aMin = avgs.length ? Math.min(...avgs) : null;
  const aMax = avgs.length ? Math.max(...avgs) : null;

  const norm = (x: number|null, lo: number|null, hi: number|null) => {
    if (x == null || lo == null || hi == null || !Number.isFinite(x) || hi - lo <= 0) return 0;
    return Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  };

  const W_FLOAT = 0.60; // strongest: smaller float better
  const W_EMP   = 0.25; // keep employees meaningful but not dominant
  const W_AVG   = 0.15; // slight nudge for liquidity consistency

  return (row: { sharesOutstanding?: number|null; employees?: number|null; avgVolume?: number|null }) => {
    // Float: reverse-normalize so smaller float → higher score
    const f = row.sharesOutstanding ?? null;
    let floatN = 0;
    if (f != null && fMin != null && fMax != null && fMax - fMin > 0) {
      const straight = norm(f, fMin, fMax);   // small→0, big→1
      floatN = 1 - straight;                  // invert: small→1, big→0
    }

    // Employees: log-normalized
    const e = row.employees ?? null;
    const eLog = e != null ? log(e) : null;
    const empN = norm(eLog, eMin, eMax);

    // Avg volume: linear
    const avgN = norm(row.avgVolume ?? null, aMin, aMax);

    return W_FLOAT * floatN + W_EMP * empN + W_AVG * avgN; // 0..1
  };
}

/* ──────────────────────────────────────────────────────────
   Route
   ────────────────────────────────────────────────────────── */
export async function POST(req: Request) {
  try {
    if (!OPENAI_API_KEY) {
      return NextResponse.json({ errorMessage: "OPENAI_API_KEY is not set on the server." }, { status: 500 });
    }
    if (OPENAI_API_KEY.startsWith("sk-proj-") && !OPENAI_PROJECT_ID) {
      return NextResponse.json({ errorMessage: "OPENAI_PROJECT_ID is required for sk-proj-* keys." }, { status: 500 });
    }

    const body = await req.json();
    const stocksIn = body.gainers || body.stocks;
    const topN = Math.max(1, Math.min(2, Number(body.topN ?? 1)));

    if (!stocksIn || !Array.isArray(stocksIn) || stocksIn.length === 0) {
      return NextResponse.json({ errorMessage: "No valid stock data provided to /api/recommendation." }, { status: 400 });
    }

    // Normalize incoming (cap to MAX_INPUT)
    const base = (stocksIn as any[]).slice(0, MAX_INPUT).map((s: any) => {
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
        ticker, price, changesPercentage, marketCap, sharesOutstanding, volume, employees,
        dollarVolume, relVolFloat,
      };
    });

    // ↓ Only enrich the most promising rows with FMP to reduce API use
    const preFmpPool = base
      .slice()
      .sort((a, b) => (b.dollarVolume ?? 0) - (a.dollarVolume ?? 0))
      .slice(0, FMP_ENRICH_LIMIT);

    const enriched = await Promise.all(
      preFmpPool.map(async (row) => {
        const [profile, ratios, news, avgVolRaw, quote] = await Promise.all([
          fmpProfileCached(row.ticker),
          fmpRatiosTTMCached(row.ticker),
          fmpNewsCached(row.ticker, 3),
          fmpAvgVolumeSmartCached(row.ticker),
          fmpQuoteCached(row.ticker),
        ]);

        const isEtf =
          profile?.isEtf === true ||
          /ETF|ETN/i.test(profile?.companyName || "") ||
          /ETF|ETN/i.test(profile?.industry || "");
        const isOTC = String(profile?.exchangeShortName || "").toUpperCase() === "OTC";
        const employees = row.employees != null ? row.employees : num(profile?.fullTimeEmployees);
        const marketCap = row.marketCap != null ? row.marketCap : num(profile?.mktCap);
        const profitMarginTTM = num(ratios?.netProfitMarginTTM) ?? num(profile?.netProfitMarginTTM) ?? null;

        const avgVolume = num(avgVolRaw);
        const relVol =
          row.volume != null && avgVolume != null && avgVolume > 0
            ? row.volume / avgVolume
            : null;

        const price = row.price ?? num(quote?.price);
        const { pos, neg } = quickHeadlineScore(news);

        return {
          ...row,
          price, marketCap, employees, profitMarginTTM, avgVolume, relVol,
          isEtf, isOTC,
          sector: profile?.sector || null,
          industry: profile?.industry || null,
          headlines: (news || []).map((n: any) => n?.title).filter(Boolean).slice(0, 5),
          headlinePos: pos, headlineNeg: neg,
        };
      })
    );

    /* Soft preference scoring (Float ↓ strongest + Employees + AvgVolume) */
    const scoreSoft = buildSoftPrefScorer(enriched);
    for (const r of enriched) {
      (r as any).softPref = scoreSoft(r as any); // 0..1
    }

    /* Hard filters (PRICE BAND: $1–$70) */
    const filtered = enriched.filter((s) => {
      const passAvgVol    = (s.avgVolume ?? 0) >= 500_000;
      const passRelVol    = (s.relVol ?? 0) >= 3.0;
      const passDollarVol = (s.dollarVolume ?? 0) >= 10_000_000;
      const p = s.price ?? 0;
      const passPrice     = p >= 1 && p <= 70;
      const passVenue     = !s.isEtf && !s.isOTC;
      const passFloat     = (s.sharesOutstanding ?? 0) > 1_999_999; // avoid ultra-tiny
      return passAvgVol && passRelVol && passDollarVol && passPrice && passVenue && passFloat;
    });

    // EXTRA price-band safety: if no "filtered" survive other rules,
    // prefer $1–$70 names from enriched before falling back to everything.
    const enrichedPriceBand = enriched.filter((s) => {
      const p = s.price ?? 0;
      return p >= 1 && p <= 70;
    });

    // Sort helper: prioritize AM tone if available, then DollarVol, then SoftPref
    const byComposite = (arr: any[]) =>
      arr.slice().sort((a, b) => {
        const pmDiff = (b.pmScore ?? -1) - (a.pmScore ?? -1);
        if (Math.abs(pmDiff) > 1e-9) return pmDiff;
        const dv = (b.dollarVolume ?? 0) - (a.dollarVolume ?? 0);
        if (Math.abs(dv) > 0) return dv;
        return ((b as any).softPref ?? 0) - ((a as any).softPref ?? 0);
      });

    const prePool =
      filtered.length
        ? filtered
        : (enrichedPriceBand.length ? enrichedPriceBand : enriched);

    const candidates = byComposite(prePool).slice(0, PREMARKET_LIMIT);

    /* ── Get or fetch the 09:00–09:45 snapshot (cached) ── */
    const symbols = candidates.map((c: any) => String(c.ticker).toUpperCase());
    const { bySym: pmBySym, skipped: pmSkippedReason } = await getOrFetchPremarket(symbols);

    // Stitch morning stats into candidates
    for (const c of candidates) {
      const s = String(c.ticker).toUpperCase();
      const pm = pmBySym[s] || {};
      (c as any).pmHigh = pm.pmHigh ?? null;
      (c as any).pmLow = pm.pmLow ?? null;
      (c as any).pmRangePct = pm.pmRangePct ?? null;
      (c as any).pmVolume = pm.pmVolume ?? null;
      (c as any).pmVWAP = pm.pmVWAP ?? null;
      (c as any).pmUpMinutePct = pm.pmUpMinutePct ?? null;
      (c as any).pmScore = pm.pmScore ?? null;
    }

    /* Prompt (JSON mode), augmented with 09:00–09:45 signals + soft pref */
    const lines = candidates.map((s: any) => {
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
        `SoftPref:${((s as any).softPref ?? 0).toFixed(2)}`, // 0..1 helper for tie-break
        `ProfitMarginTTM:${s.profitMarginTTM != null ? (Math.abs(s.profitMarginTTM) <= 1 ? (s.profitMarginTTM*100).toFixed(2) : s.profitMarginTTM.toFixed(2)) + "%" : "n/a"}`,
        `Sector:${s.sector ?? "n/a"}`,
        `Industry:${s.industry ?? "n/a"}`,
        `Headlines(+/-):${s.headlinePos}/${s.headlineNeg}`,
        // ── Morning 09:00–09:45 fields ──
        `AM_High:${(s as any).pmHigh ?? "n/a"}`,
        `AM_Low:${(s as any).pmLow ?? "n/a"}`,
        `AM_RangePct:${(s as any).pmRangePct != null ? (((s as any).pmRangePct*100).toFixed(2) + "%") : "n/a"}`,
        `AM_Vol:${(s as any).pmVolume ?? "n/a"}`,
        `AM_VWAP:${(s as any).pmVWAP ?? "n/a"}`,
        `AM_UpMin:${(s as any).pmUpMinutePct != null ? (((s as any).pmUpMinutePct*100).toFixed(0) + "%") : "n/a"}`,
        `AM_Score:${(s as any).pmScore != null ? (s as any).pmScore.toFixed(2) : "n/a"}`,
      ].join(" | ");
    });

    const headlinesBlock = candidates
      .map((s: any) => `### ${s.ticker}\n- ${s.headlines?.join("\n- ") || "(no recent headlines)"}`)
      .join("\n\n");

    const system = `
You are a disciplined **intraday** assistant selecting up to **two** long candidates to hold **< 1 day**.
Use ONLY the provided data (no outside facts).

## Hard Filters (already enforced server-side)
- AvgVolume ≥ 500,000
- Live Volume ≥ 3 × AvgVolume (RelVol ≥ 3.0)
- Dollar Volume today ≥ $10,000,000
- Price between $1 and $70
- Exclude ETFs/ETNs and OTC
- Float (sharesOutstanding) > 1,999,999

## Primary Signals (weight the 09:00–09:45 tone)
- Liquidity/Momentum: higher DollarVol, RelVol (live/avg), RelVolFloat.
- **09:00–09:45 tone**: prefer higher AM_RangePct, higher AM_Vol, AM_UpMin, price relative to AM_VWAP, and overall AM_Score.
- Spike Potential: **smaller Float is best** (≤ 50M preferred) but allow larger with very high DollarVol.
- Quality: prefer positive netProfitMarginTTM.
- Catalysts: positive headlines; penalize clusters of negatives.
- **Soft Preference (tie-break)**: when two candidates are similar on the above,
  **prefer smaller Float strongest**, then **higher Employees**, then **higher AvgVol**
  (SoftPref 0–1 is provided; MarketCap should be ignored).

## Output (strict JSON)
{
  "picks": ["TOP1","TOP2"],
  "reasons": { "TOP1": ["bullet","bullet"], "TOP2": ["bullet"] },
  "risk": "one short sentence on spread/whipsaw/headline risk"
}
`.trim();

    const userMsg = `
Candidates (numeric fields may be "n/a"):

${lines.join("\n")}

Recent headlines (titles only):
${headlinesBlock}

Select up to **${topN}** best long candidates (ranked). Output JSON as specified.
`.trim();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    };
    if (OPENAI_API_KEY.startsWith("sk-proj-")) headers["OpenAI-Project"] = OPENAI_PROJECT_ID;
    if (OPENAI_ORG) headers["OpenAI-Organization"] = OPENAI_ORG;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
        temperature: 0.15,
        max_tokens: 700,
        response_format: { type: "json_object" as const },
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("OpenAI error:", res.status, errText);
      return NextResponse.json({ errorMessage: `OpenAI API error ${res.status}: ${errText || "Unknown error"}` }, { status: 500 });
    }

    const data = await res.json();
    let content: string = data?.choices?.[0]?.message?.content ?? "";
    let modelObj: any = null;
    try {
      modelObj = content ? JSON.parse(content) : null;
    } catch {
      const recovered = parsePicksFromText(content);
      modelObj = { picks: recovered, reasons: {}, risk: "" };
    }

    const picksFromModel: string[] = Array.isArray(modelObj?.picks)
      ? modelObj.picks.map((s: any) => String(s).toUpperCase())
      : parsePicksFromText(content);

    const candidateTickers = new Set(candidates.map((c: any) => String(c.ticker).toUpperCase()));
    const validPicks = picksFromModel.filter(p => candidateTickers.has(p));
    const finalPicks = (validPicks.length ? validPicks : (candidates[0]?.ticker ? [String(candidates[0].ticker).toUpperCase()] : []))
      .slice(0, topN);

    const reasonsMap: Record<string, string[]> = modelObj?.reasons || {};
    const risk: string | undefined = typeof modelObj?.risk === "string" ? modelObj.risk : undefined;

    /* Save picks with explanation (includes AM bullets if present) */
    const saved: any[] = [];
    for (const sym of finalPicks) {
      const t = sym.toUpperCase();
      const c = candidates.find((x: any) => String(x.ticker).toUpperCase() === t);
      const priceNum = Number(c?.price ?? 0);

      const expl = buildExplanationForPick(t, c as any, reasonsMap[t], risk);

      try {
        const row = await prisma.recommendation.create({
          data: {
            ticker: t,
            price: priceNum,
            explanation: expl,
          },
        });
        saved.push(row);
      } catch (e) {
        console.error("Failed to save recommendation for", t, e);
      }
    }

    return NextResponse.json({
      picks: finalPicks,
      primary: finalPicks[0] ?? null,
      secondary: finalPicks[1] ?? null,
      reasons: reasonsMap,
      risk: risk ?? "",
      savedCount: saved.length,
      saved,
      raw: typeof content === "string" ? content : JSON.stringify(content),
      context: {
        tickers: candidates.map((x: any) => ({
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
          softPref: (x as any).softPref ?? 0, // expose for debugging
          // Morning 09:00–09:45 context
          amHigh: x.pmHigh ?? null,
          amLow: x.pmLow ?? null,
          amRangePct: x.pmRangePct ?? null,
          amVolume: x.pmVolume ?? null,
          amVWAP: x.pmVWAP ?? null,
          amUpMinutePct: x.pmUpMinutePct ?? null,
          amScore: x.pmScore ?? null,
        })),
        pmCache: {
          date: pmCacheDate,
          window: pmCacheWindow,
          endISO: pmCacheEndISO,
          lastFetchMs: pmLastFetchMs,
          throttledMs: PM_FETCH_THROTTLE_MS,
          skippedReason: pmSkippedReason ?? null,
        },
        nowET: nowET().toISOString(),
      },
    });
  } catch (error: any) {
    console.error("Recommendation route error:", error);
    return NextResponse.json({ errorMessage: error?.message || "Failed to analyze stocks" }, { status: 500 });
  }
}

/* Optional quick debug: returns last 10 saved rows */
export async function GET() {
  try {
    const last = await prisma.recommendation.findMany({
      orderBy: { id: "desc" },
      take: 10,
    });
    return NextResponse.json({ last });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "unknown" }, { status: 500 });
  }
}
