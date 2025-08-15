import { NextResponse } from "next/server";

// Replace later with your real AI logic
export async function POST() {
  const universe = ["TSLA","NVDA","AMD","AAPL","PLTR","SMCI","META","NFLX"];
  const pick = universe[Math.floor(Math.random() * universe.length)];
  return NextResponse.json({ ticker: pick });
}
