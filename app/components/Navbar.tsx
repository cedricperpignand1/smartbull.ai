"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Image from "next/image";
import { signOut } from "next-auth/react";

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
    <nav className="bg-white text-black px-8 sm:px-20 py-6 shadow-md">
      <div className="w-full flex items-center justify-between">
        {/* Left side with spinning logo */}
        <div
          className="flex items-center gap-4 cursor-pointer"
          onClick={() => router.push("/")}
        >
          <Image
            src="/logo4.png" // make sure the logo is placed in public/logo.png
            alt="Logo"
            width={90}
            height={90}
            className="object-contain animate-spin-slow"
          />
          <div className="text-3xl sm:text-4xl font-bold tracking-wide">
            SmartBull.ai
          </div>
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
              onClick={() => signOut({ callbackUrl: "/" })}
              className="bg-red-600 hover:bg-red-700 text-white px-5 py-2 rounded-lg text-base font-semibold transition"
            >
              Sign Out
            </button>
          </div>

          <div className="text-lg font-mono">{time}</div>
        </div>
      </div>
    </nav>
  );
}
