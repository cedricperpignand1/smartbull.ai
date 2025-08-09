// app/api/bot/pause/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic"; // Always run fresh

// GET: return current paused state
export async function GET() {
  try {
    const state = await prisma.botState.findUnique({ where: { id: 1 } });
    return NextResponse.json({ paused: state?.paused ?? false });
  } catch (err) {
    console.error("GET /api/bot/pause error", err);
    return NextResponse.json({ error: "Failed to get pause state" }, { status: 500 });
  }
}

// POST: update paused state
export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (typeof body.paused !== "boolean") {
      return NextResponse.json({ error: "paused must be boolean" }, { status: 400 });
    }

    const state = await prisma.botState.upsert({
      where: { id: 1 },
      update: { paused: body.paused },
      create: {
        id: 1,
        cash: 4000, // start cash if new
        pnl: 0,
        equity: 4000,
        paused: body.paused,
      },
    });

    return NextResponse.json({ paused: state.paused });
  } catch (err) {
    console.error("POST /api/bot/pause error", err);
    return NextResponse.json({ error: "Failed to update pause state" }, { status: 500 });
  }
}
