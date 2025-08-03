import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/prisma";

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json();

    if (!email || !password) {
      return NextResponse.json({ message: "Email and password required" }, { status: 400 });
    }

    // Check if user already exists
    const existing = await prisma.user.findUnique({
      where: { email },
    });
    if (existing) {
      return NextResponse.json({ message: "User already exists" }, { status: 400 });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    await prisma.user.create({
      data: { email, hashedPassword },
    });

    return NextResponse.json({ message: "User registered successfully" }, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ message: "Error registering user" }, { status: 500 });
  }
}
