"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Image from "next/image";
import { signOut } from "next-auth/react";

export default function Navbar() {
  const router = useRouter();
  const [time, setTime] = useState<string>("");

  useEffect(() => {
    const t = setInterval(() => {
      setTime(
        new Date().toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      );
    }, 1000);

    setTime(
      new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    );

    return () => clearInterval(t);
  }, []);

  return (
    <header className="sticky top-0 z-50 w-full">
      {/* Background behind navbar */}
      <div className="w-full bg-gray-100">
        {/* Centered container */}
        <div className="mx-auto max-w-screen-2xl px-3 sm:px-6">
          {/* White rounded bar */}
          <div className="h-16 sm:h-18 flex items-center">
            <div className="w-full bg-white rounded-xl sm:rounded-2xl shadow-md border border-zinc-200 px-3 sm:px-4">
              <div className="h-16 sm:h-[64px] flex items-center justify-between gap-3">
                {/* Left: brand */}
                <button
                  onClick={() => router.push("/")}
                  className="flex items-center gap-2 sm:gap-3 group"
                  aria-label="Go to Home"
                >
                  <Image
                    src="/logo4.png"
                    alt="SmartBull Logo"
                    width={32}
                    height={32}
                    className="h-8 w-8 object-contain"
                    priority
                  />
                  <span className="text-lg sm:text-xl font-extrabold tracking-tight text-gray-900">
                    <span className="text-amber-600">Smart</span>Bull.ai
                  </span>
                </button>

                {/* Right: actions */}
                <div className="flex items-center gap-2 sm:gap-3">
                  {/* Time pill */}
                  <span className="hidden sm:inline-flex items-center rounded-md border border-gray-300 bg-gray-50 text-gray-700 px-3 py-1 text-xs font-medium font-mono">
                    {time || "--:--:--"}
                  </span>

                  {/* My P&L */}
                  <button
                    onClick={() => router.push("/pnl")}
                    className="inline-flex items-center rounded-lg border border-gray-400/70 bg-white px-3 sm:px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50"
                  >
                    My P&L
                  </button>

                  {/* Sign Out */}
                  <button
                    onClick={() => signOut({ callbackUrl: "/" })}
                    className="inline-flex items-center rounded-lg bg-black text-white px-3 sm:px-4 py-2 text-sm font-semibold hover:bg-gray-900"
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
