// /app/api/stocks/debug/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const key = process.env.FMP_API_KEY || "";
  const url = `https://financialmodelingprep.com/api/v3/stock_market/gainers?apikey=${key}`;

  let status = 0, text = "";
  try {
    const res = await fetch(url, { cache: "no-store" });
    status = res.status;
    text = await res.text();
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, reason: "network_error", message: e?.message }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      ok: status === 200,
      status,
      hasKey: Boolean(key),
      sample: text.slice(0, 400),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
