"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function Navbar() {
  const router = useRouter();
  const [time, setTime] = useState<string>("");

  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      const options: Intl.DateTimeFormatOptions = {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      };
      setTime(now.toLocaleTimeString([], options));
    };

    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <nav className="bg-black text-white px-8 sm:px-20 py-6 shadow-md">
      <div className="w-full flex items-center justify-between">
        {/* Left side */}
        <div
          onClick={() => router.push("/")}
          className="cursor-pointer text-3xl sm:text-4xl font-bold tracking-wide"
        >
          SmartBull.ai
        </div>

        {/* Right side */}
        <div className="flex items-center gap-6">
          <div className="flex gap-4">
            <button
              onClick={() => router.push("/")}
              className="bg-gray-700 hover:bg-gray-800 text-white px-5 py-2 rounded-lg text-base font-semibold transition"
            >
              Home
            </button>
            <button
              onClick={() => router.push("/pnl")}
              className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg text-base font-semibold transition"
            >
              My P&amp;L
            </button>
            <button
              onClick={() => router.push("/signup")}
              className="bg-green-600 hover:bg-green-700 text-white px-5 py-2 rounded-lg text-base font-semibold transition"
            >
              Sign Up
            </button>
            <button
              onClick={() => router.push("/login")}
              className="bg-purple-600 hover:bg-purple-700 text-white px-5 py-2 rounded-lg text-base font-semibold transition"
            >
              Login
            </button>
          </div>

          <div className="text-lg font-mono">{time}</div>
        </div>
      </div>
    </nav>
  );
}
