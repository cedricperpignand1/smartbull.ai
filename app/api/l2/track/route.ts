import { NextResponse } from "next/server";
import { setActiveSymbols, getActiveSymbols } from "@/lib/l2Tracker";
import { reconcileSubscriptions } from "../../../../lib/databentoBridge";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(()=>({}));
  const symbols: string[] = Array.isArray(body?.symbols) ? body.symbols : [];
  const { symbols: active } = setActiveSymbols(symbols);
  await reconcileSubscriptions().catch(()=>{});
  return NextResponse.json({ ok:true, active });
}

export async function GET() {
  return NextResponse.json(getActiveSymbols());
}
