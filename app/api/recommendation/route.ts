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
export const dynamic = "force-dynamic";

/* ──────────────────────────────────────────────────────────
   Config
   ────────────────────────────────────────────────────────── */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_PROJECT_ID = process.env.OPENAI_PROJECT_ID || "";
const OPENAI_ORG = process.env.OPENAI_ORGANIZATION_ID || "";

// Alpaca (free IEX feed works for premarket with these keys)
const ALPACA_KEY = process.env.ALPACA_KEY || process.env.ALPACA_API_KEY || "";
const ALPACA_SECRET = process.env.ALPACA_SECRET || process.env.ALPACA_API_SECRET || "";

// Base URL for server→server fetch (e.g. https://yourapp.com). Leave blank locally.
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "";
const makeUrl = (p: string) => (BASE_URL ? `${BASE_URL}${p}` : p);

/* ──────────────────────────────────────────────────────────
   Limits to control API usage
   ────────────────────────────────────────────────────────── */
const MAX_INPUT = 20;                 // read at most 20 incoming rows
const PREMARKET_LIMIT = 8;            // analyze premarket for top 8 (single Alpaca call)
const FMP_ENRICH_LIMIT = Math.max(8, PREMARKET_LIMIT); // ensure we enrich at least 8
const DEFAULT_TOP_N = 2;              // default to TWO

// Premarket+open window you want the model to consider
const PM_START_H = 9, PM_START_M = 0;
const PM_END_H   = 9, PM_END_M   = 45;

// Optional: global toggle to disable PM fetch without redeploy
const PM_ENABLED = (process.env.RECOMMENDATION_PM_ENABLED ?? "true").toLowerCase() !== "false";

// ⬇️ Central float threshold (server-enforced)
const MIN_FLOAT = 2_000_000;

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
      ? ((v ?? 0) * 0.4 + (r ?? 0) * 0.4 + (u ?? 0) * 0.2)
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

  const fresh = await fetchBarsWindow(symbols, startISO, endISO);

  for (const s of symbols) {
    pmCache[s] = fresh[s] || pmCache[s] || {};
  }
  pmCacheWindow = "09:00–09:45";
  pmCacheEndISO = endISO;
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
    industry?: string | null;
    sector?: string | null;
    country?: string | null;
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
  if (c?.country) bullets.push(`Country ${c.country}`);
  if (risk?.trim()) bullets.push(`Risk: ${risk.trim()}`);
  const clean = bullets.map(b => b.replace(/\s+/g, " ").trim()).filter(Boolean);
  return clean.length ? clean.join(" • ") : `${t.toUpperCase()} selected for momentum, liquidity & morning tone.`;
}

/* ──────────────────────────────────────────────────────────
   Soft preference helpers
   ────────────────────────────────────────────────────────── */
function buildSoftPrefScorer(rows: Array<{ sharesOutstanding?: number|null; employees?: number|null; avgVolume?: number|null }>) {
  const floats = rows.map(r => r.sharesOutstanding ?? null).filter((v): v is number => v != null && Number.isFinite(v));
  const emps   = rows.map(r => r.employees ?? null).filter((v): v is number => v != null && Number.isFinite(v));
  const avgs   = rows.map(r => r.avgVolume ?? null).filter((v): v is number => v != null && Number.isFinite(v));

  const fMin = floats.length ? Math.min(...floats) : null;
  const fMax = floats.length ? Math.max(...floats) : null;

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
    const f = row.sharesOutstanding ?? null;
    let floatN = 0;
    if (f != null && fMin != null && fMax != null && fMax - fMin > 0) {
      const straight = norm(f, fMin, fMax);
      floatN = 1 - straight; // invert: small→1, big→0
    }

    const e = row.employees ?? null;
    const eLog = e != null ? log(e) : null;
    const empN = norm(eLog, eMin, eMax);

    const avgN = norm(row.avgVolume ?? null, aMin, aMax);

    return W_FLOAT * floatN + W_EMP * empN + W_AVG * avgN; // 0..1
  };
}

/* ──────────────────────────────────────────────────────────
   NEW: Preference rules & comparator (hard guidance)
   + Industry tilt + Geography soft bias
   ────────────────────────────────────────────────────────── */
const LOW_FLOAT_MAX = 50_000_000;      // treat as "low float" if <= 50M shares
const SMALL_CAP_MAX = 1_000_000_000;   // treat as "small cap" if <= $1B

// soft nudges (0..1 scale)
const INDUSTRY_TILT_BONUS = 0.10;  // add to softPref if matches daily winner
const US_BONUS            = 0.02;  // small nudge for US names
const CHINA_PENALTY       = 0.07;  // small penalty for China/HK names

function isLowFloat(x?: number | null) {
  return x != null && x > 0 && x <= LOW_FLOAT_MAX;
}
function isSmallCap(x?: number | null) {
  return x != null && x > 0 && x <= SMALL_CAP_MAX;
}
function isChinaish(country?: string | null): boolean {
  if (!country) return false;
  const c = country.toLowerCase();
  return c.includes("china") || c === "cn" || c.includes("hong kong") || c === "hk";
}
function isUS(country?: string | null): boolean {
  if (!country) return false;
  const c = country.toLowerCase();
  return c.includes("united states") || c === "us" || c === "usa" || c === "u.s.";
}

type Tilt = { label: string; count: number; members: string[] } | null;
function computeIndustryWinner(rows: Array<{ industry?: string|null; sector?: string|null; ticker: string }>): Tilt {
  if (!rows.length) return null;
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const k = (r.industry || r.sector || "Unknown").trim() || "Unknown";
    const arr = map.get(k) || [];
    arr.push(r.ticker.toUpperCase());
    map.set(k, arr);
  }
  const hasLabeled = Array.from(map.keys()).some(k => k !== "Unknown");
  if (hasLabeled && map.has("Unknown")) map.delete("Unknown");

  const groups = Array.from(map.entries()).map(([label, members]) => ({ label, count: members.length, members: members.sort() }));
  if (!groups.length) return null;
  groups.sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label));
  return groups[0];
}

/**
 * Preference comparator used after momentum/liquidity pre-sort:
 *  1) Prefer low-float (<= 50M)
 *  2) Prefer small-cap (<= $1B)
 *  3) Among low-float vs low-float, prefer higher employees
 *  4) Lower absolute float wins (if both low-float and employees tie)
 *  5) NEW: Prefer names in the day's winner industry (soft tiebreak)
 *  6) NEW: Prefer non-China/HK vs China/HK (soft tiebreak)
 *  7) Fall back to pmScore, then dollarVolume, then softPrefAdj
 */
function compareByPreferenceFactory(winnerLabel?: string | null) {
  return function compareByPreference(a: any, b: any) {
    const aLow = isLowFloat(a.sharesOutstanding);
    const bLow = isLowFloat(b.sharesOutstanding);
    if (aLow !== bLow) return aLow ? -1 : 1;

    const aSm = isSmallCap(a.marketCap);
    const bSm = isSmallCap(b.marketCap);
    if (aSm !== bSm) return aSm ? -1 : 1;

    if (aLow && bLow) {
      const ae = a.employees ?? 0;
      const be = b.employees ?? 0;
      if (ae !== be) return be - ae;
      const af = a.sharesOutstanding ?? Number.POSITIVE_INFINITY;
      const bf = b.sharesOutstanding ?? Number.POSITIVE_INFINITY;
      if (af !== bf) return af - bf;
    }

    // 5) industry tilt (soft)
    if (winnerLabel) {
      const aWin = (a.industry || a.sector) === winnerLabel;
      const bWin = (b.industry || b.sector) === winnerLabel;
      if (aWin !== bWin) return aWin ? -1 : 1;
    }

    // 6) geo soft bias
    const aChina = isChinaish(a.country);
    const bChina = isChinaish(b.country);
    if (aChina !== bChina) return aChina ? 1 : -1; // prefer non-China

    const pm = (b.pmScore ?? -1) - (a.pmScore ?? -1);
    if (Math.abs(pm) > 1e-12) return pm;
    const dv = (b.dollarVolume ?? 0) - (a.dollarVolume ?? 0);
    if (dv !== 0) return dv;

    return ((b.softPrefAdj ?? b.softPref ?? 0) - (a.softPrefAdj ?? a.softPref ?? 0));
  };
}

/* Small helper for fetch timeouts (used for OpenAI call) */
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
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
    const topN = Math.max(1, Math.min(2, Number(body.topN ?? DEFAULT_TOP_N))); // default TWO

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
      const avgVolume = num(s.avgVolume); // prefer upstream value if provided
      return {
        ticker, price, changesPercentage, marketCap, sharesOutstanding, volume, employees,
        dollarVolume, relVolFloat, avgVolume,
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
          row.avgVolume ?? fmpAvgVolumeSmartCached(row.ticker), // ⬅️ use incoming avgVolume if present
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

        // NEW: capture geography
        const country = (profile?.countryISO || profile?.country || null) as string | null;

        return {
          ...row,
          price, marketCap, employees, profitMarginTTM, avgVolume, relVol,
          isEtf, isOTC,
          sector: profile?.sector || null,
          industry: profile?.industry || null,
          country,
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

    /* ── NEW: compute winner industry and add geo/tilt bias to softPref ── */
    const winner = computeIndustryWinner(enriched.map(e => ({ ticker: e.ticker, industry: e.industry, sector: e.sector })));
    for (const r of enriched) {
      let bias = 0;
      const label = r.industry || r.sector || null;
      if (winner && label === winner.label) bias += INDUSTRY_TILT_BONUS;
      if (isUS(r.country)) bias += US_BONUS;
      if (isChinaish(r.country)) bias -= CHINA_PENALTY;
      (r as any).softPrefAdj = Math.max(0, Math.min(1, (r as any).softPref + bias));
    }

    /* Hard filters (PRICE BAND: $1–$70 + enforce MIN_FLOAT) */
    const filtered = enriched.filter((s) => {
      const passAvgVol    = (s.avgVolume ?? 0) >= 500_000;
      const passRelVol    = (s.relVol ?? 0) >= 3.0;
      const passDollarVol = (s.dollarVolume ?? 0) >= 10_000_000;
      const p = s.price ?? 0;
      const passPrice     = p >= 1 && p <= 70;
      const passVenue     = !s.isEtf && !s.isOTC;
      const passFloat     = (s.sharesOutstanding ?? 0) >= MIN_FLOAT;
      return passAvgVol && passRelVol && passDollarVol && passPrice && passVenue && passFloat;
    });

    // EXTRA price-band safety: fallback also enforces float now
    const enrichedPriceBand = enriched.filter((s) => {
      const p = s.price ?? 0;
      const f = s.sharesOutstanding ?? 0;
      return p >= 1 && p <= 70 && f >= MIN_FLOAT;
    });

    // Last-chance fallback that still respects float
    const lastChance = enriched.filter((s) => (s.sharesOutstanding ?? 0) >= MIN_FLOAT);

    // Sort helper: prioritize AM tone if available, then DollarVol, then SoftPrefAdj
    const byComposite = (arr: any[]) =>
      arr.slice().sort((a, b) => {
        const pmDiff = (b.pmScore ?? -1) - (a.pmScore ?? -1);
        if (Math.abs(pmDiff) > 1e-9) return pmDiff;
        const dv = (b.dollarVolume ?? 0) - (a.dollarVolume ?? 0);
        if (Math.abs(dv) > 0) return dv;
        return ((b as any).softPrefAdj ?? (b as any).softPref ?? 0) - ((a as any).softPrefAdj ?? (a as any).softPref ?? 0);
      });

    const prePool =
      filtered.length
        ? filtered
        : (enrichedPriceBand.length ? enrichedPriceBand : lastChance);

    // First pass: momentum/liquidity order
    const candidatesBase = byComposite(prePool).slice(0, PREMARKET_LIMIT);

    /* ── Get or fetch the 09:00–09:45 snapshot (cached) ── */
    const symbols = candidatesBase.map((c: any) => String(c.ticker).toUpperCase());
    const { bySym: pmBySym, skipped: pmSkippedReason } = await getOrFetchPremarket(symbols);

    // Stitch morning stats into candidates
    const candidates = candidatesBase.map((c: any) => {
      const s = String(c.ticker).toUpperCase();
      const pm = pmBySym[s] || {};
      return {
        ...c,
        pmHigh: pm.pmHigh ?? null,
        pmLow: pm.pmLow ?? null,
        pmRangePct: pm.pmRangePct ?? null,
        pmVolume: pm.pmVolume ?? null,
        pmVWAP: pm.pmVWAP ?? null,
        pmUpMinutePct: pm.pmUpMinutePct ?? null,
        pmScore: pm.pmScore ?? null,
      };
    });

    // Second pass: apply explicit preference rules + tilt/geo soft tiebreaks
    const compareByPreference = compareByPreferenceFactory(winner?.label);
    const prefSorted = candidates.slice().sort(compareByPreference);

    /* ── Prompt (JSON mode) ── */
    const lines = prefSorted.map((s: any) => {
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
        `SoftPref:${((s as any).softPref ?? 0).toFixed(2)}`,
        `SoftPrefAdj:${((s as any).softPrefAdj ?? (s as any).softPref ?? 0).toFixed(2)}`,
        `ProfitMarginTTM:${s.profitMarginTTM != null ? (Math.abs(s.profitMarginTTM) <= 1 ? (s.profitMarginTTM*100).toFixed(2) : s.profitMarginTTM.toFixed(2)) + "%" : "n/a"}`,
        `Sector:${s.sector ?? "n/a"}`,
        `Industry:${s.industry ?? "n/a"}`,
        `Country:${s.country ?? "n/a"}`,
        `Headlines(+/-):${s.headlinePos}/${s.headlineNeg}`,
        `AM_High:${(s as any).pmHigh ?? "n/a"}`,
        `AM_Low:${(s as any).pmLow ?? "n/a"}`,
        `AM_RangePct:${(s as any).pmRangePct != null ? (((s as any).pmRangePct*100).toFixed(2) + "%") : "n/a"}`,
        `AM_Vol:${(s as any).pmVolume ?? "n/a"}`,
        `AM_VWAP:${(s as any).pmVWAP ?? "n/a"}`,
        `AM_UpMin:${(s as any).pmUpMinutePct != null ? (((s as any).pmUpMinutePct*100).toFixed(0) + "%") : "n/a"}`,
        `AM_Score:${(s as any).pmScore != null ? (s as any).pmScore.toFixed(2) : "n/a"}`,
      ].join(" | ");
    });

    const headlinesBlock = prefSorted
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

## Cedric Preference Policy (must obey for tie-breaks and close calls)
1) Prefer **low-float** (≤ 50M) over higher float.
2) Prefer **small-cap** (≤ $1B) over larger cap when other signals are similar.
3) If the top two are both low-float, **prefer the one with higher employees**.
4) If choosing between a high-cap and a low-cap/low-float name in the top two, **prefer the low-float/small-cap**.

## Daily Tilt
- Winner industry (from the provided candidates): **${winner?.label ?? "n/a"}** (count ${winner?.count ?? 0}).
- When signals are close, **prefer** names in this industry. Do not override much stronger momentum/liquidity.

## Geography (soft rule)
- When signals are close, **prefer U.S. names** over China/Hong Kong ADRs or China/HK-domiciled names.
- This is a **small penalty only**; do not overrule a clearly superior momentum/liquidity setup.

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

Industry Tilt: ${winner?.label ?? "n/a"} (members: ${(winner?.members ?? []).join(", ") || "—"})

Select up to **${topN}** best long candidates (ranked). Output JSON as specified.
`.trim();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    };
    if (OPENAI_API_KEY.startsWith("sk-proj-")) headers["OpenAI-Project"] = OPENAI_PROJECT_ID;
    if (OPENAI_ORG) headers["OpenAI-Organization"] = OPENAI_ORG;

    const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
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
    }, 30_000);

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

    // Validate model picks against candidate set AND float threshold
    const byTicker: Record<string, any> = {};
    for (const c of (prefSorted as any[])) byTicker[String(c.ticker).toUpperCase()] = c;

    const meetsFloat = (row: any) => (row?.sharesOutstanding ?? 0) >= MIN_FLOAT;

    const validModel = picksFromModel.filter(p => {
      const c = byTicker[p];
      return !!c && meetsFloat(c);
    });

    // Build final picks with POST-ENFORCEMENT of policy
    const finalPicks: string[] = [];
    const already = new Set<string>();

    const pushPick = (t: string) => {
      const u = t.toUpperCase();
      if (!already.has(u) && byTicker[u]) {
        finalPicks.push(u);
        already.add(u);
      }
    };

    // 1) Try model picks in order, but replace anti-policy choices when possible
    for (const p of validModel) {
      if (finalPicks.length >= topN) break;
      const cand = byTicker[p];

      const candLow = isLowFloat(cand?.sharesOutstanding);
      const candSm  = isSmallCap(cand?.marketCap);

      if (!(candLow || candSm)) {
        const alt = (prefSorted as any[]).find(x =>
          (isLowFloat(x.sharesOutstanding) || isSmallCap(x.marketCap)) &&
          (x?.sharesOutstanding ?? 0) >= MIN_FLOAT &&
          !already.has(String(x.ticker).toUpperCase())
        );
        pushPick(alt ? alt.ticker : p);
      } else {
        pushPick(p);
      }
    }

    // 2) Fill remaining slots strictly from preference order (still enforce float)
    for (const c of (prefSorted as any[])) {
      if (finalPicks.length >= topN) break;
      if (!meetsFloat(c)) continue;
      pushPick(c.ticker);
    }

    const reasonsMap: Record<string, string[]> = modelObj?.reasons || {};
    const risk: string | undefined = typeof modelObj?.risk === "string" ? modelObj.risk : undefined;

    /* L2 tiebreaker (optional) */
    try {
      const toRank = (finalPicks as string[]).slice(0, 2);
      if (toRank.length === 2) {
        const qs = encodeURIComponent(toRank.join(","));
        const r = await fetch(makeUrl(`/api/l2/pressure?symbols=${qs}`), { cache: "no-store" });
        if (r.ok) {
          const j = await r.json();
          const map: Record<string, number | null> = {};
          for (const row of (j?.results ?? [])) {
            map[String(row.symbol).toUpperCase()] = (typeof row.score === "number" ? row.score : null);
          }
          const a = toRank[0].toUpperCase();
          const b = toRank[1].toUpperCase();
          const sa = map[a]; const sb = map[b];
          if (sa != null && sb != null && sb > sa) {
            // swap
            finalPicks[0] = b;
            finalPicks[1] = a;
          }
        }
      }
    } catch { /* ignore */ }

    /* Save picks with explanation (includes tilt / geo bullets) */
    const saved: any[] = [];
    for (const sym of finalPicks) {
      const t = sym.toUpperCase();
      const c = (prefSorted as any[]).find((x: any) => String(x.ticker).toUpperCase() === t);

      const priceNum = (c?.price != null && Number.isFinite(Number(c.price)))
        ? Number(c.price)
        : null;

      // augment reasons with tilt/geo notes
      const baseReasons = Array.isArray(reasonsMap[t]) ? [...reasonsMap[t]] : [];
      if (winner && (c?.industry || c?.sector) === winner.label) {
        baseReasons.unshift(`Industry tilt: ${winner.label}`);
      }
      if (isChinaish(c?.country)) {
        baseReasons.push("Geo: China/HK (soft penalty applied)");
      } else if (isUS(c?.country)) {
        baseReasons.push("Geo: U.S. (small preference)");
      }

      const expl = buildExplanationForPick(t, c as any, baseReasons, risk);

      try {
        const row = await prisma.recommendation.create({
          data: {
            ticker: t,
            ...(priceNum != null ? { price: priceNum } : {}), // omit if null
            explanation: expl,
          },
        });
        saved.push(row);
      } catch (e) {
        console.error("Failed to save recommendation for", t, e);
      }
    }

    // 🔔 Tell the L2 streaming layer which 1–2 symbols to track now
    try {
      const toTrack = finalPicks.slice(0, 2);
      if (toTrack.length) {
        fetch(makeUrl(`/api/l2/track`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbols: toTrack })
        }).catch(() => {});
      }
    } catch {}

    return NextResponse.json({
      picks: finalPicks.slice(0, 2),
      primary: finalPicks[0] ?? null,
      secondary: finalPicks[1] ?? null,
      reasons: reasonsMap,
      risk: risk ?? "",
      savedCount: saved.length,
      saved,
      raw: typeof content === "string" ? content : JSON.stringify(content),
      context: {
        industryWinner: winner,
        tickers: (prefSorted as any[]).map((x: any) => ({
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
          softPref: (x as any).softPref ?? 0,
          softPrefAdj: (x as any).softPrefAdj ?? (x as any).softPref ?? 0,
          amHigh: x.pmHigh ?? null,
          amLow: x.pmLow ?? null,
          amRangePct: x.pmRangePct ?? null,
          amVolume: x.pmVolume ?? null,
          amVWAP: x.pmVWAP ?? null,
          amUpMinutePct: x.pmUpMinutePct ?? null,
          amScore: x.pmScore ?? null,
          isLowFloat: isLowFloat(x.sharesOutstanding),
          isSmallCap: isSmallCap(x.marketCap),
          sector: x.sector,
          industry: x.industry,
          country: x.country ?? null,
        })),
        pmCache: {
          date: pmCacheDate,
          window: pmCacheWindow,
          endISO: pmCacheEndISO,
          lastFetchMs: pmLastFetchMs,
          throttledMs: PM_FETCH_THROTTLE_MS,
          skippedReason: pmSkippedReason ?? null,
        },
        policy: {
          defaultTopN: DEFAULT_TOP_N,
          lowFloatMax: LOW_FLOAT_MAX,
          smallCapMax: SMALL_CAP_MAX,
          minFloat: MIN_FLOAT,
          industryTiltBonus: INDUSTRY_TILT_BONUS,
          geoUSBonus: US_BONUS,
          geoChinaPenalty: CHINA_PENALTY,
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
