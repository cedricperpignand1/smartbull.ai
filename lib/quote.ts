const FMP_KEY = process.env.FMP_API_KEY;

export async function getQuote(ticker: string): Promise<number | null> {
  if (!FMP_KEY) {
    console.error("Missing FMP_API_KEY");
    return null;
  }
  try {
    const url = `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(
      ticker
    )}?apikey=${FMP_KEY}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;

    const j = await r.json();
    const q = j?.[0];
    const p = q?.price ?? q?.ask ?? q?.bid ?? null;

    return typeof p === "number" ? p : null;
  } catch (e) {
    console.error("Quote fetch error:", e);
    return null;
  }
}
