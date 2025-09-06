// components/Navbar.tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Image from "next/image";
import { signOut } from "next-auth/react";

export default function Navbar() {
  const router = useRouter();
  const [time, setTime] = useState<string>("");

  /* ── Clock ────────────────────────────────────────────────── */
  useEffect(() => {
    const tick = () =>
      setTime(
        new Date().toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="sticky top-0 z-50 w-full">
      {/* Frosted glass bar over bluebackground.png */}
      <div
        className="
          h-16 md:h-18
          w-full
          bg-white/20 backdrop-blur-lg
          border-b border-white/30
          shadow-sm
        "
      >
        <div className="mx-auto max-w-screen-2xl h-full px-4 flex items-center justify-between">
          {/* LEFT: Logo + Name */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push("/")}
              className="flex items-center gap-3 hover:opacity-95"
              aria-label="Go to Home"
            >
              <Image
                src="/logo4.png"
                alt="SmartBull Logo"
                width={100}
                height={100}
                className="h-15 w-15 object-contain"
                priority
              />
              <span className="text-white drop-shadow text-xl md:text-2xl font-extrabold tracking-tight">
                <span className="text-white/90">Smart</span>
                <span className="text-white">Bull.ai</span>
              </span>
            </button>
          </div>

          {/* CENTER: (intentionally left empty) */}
          <div />

          {/* RIGHT: Time + Sign Out */}
          <div className="flex items-center gap-4">
            <span
              className="
                hidden sm:inline-flex items-center
                rounded-md px-3 py-1.5 text-sm md:text-base font-medium font-mono
                bg-white/25 ring-1 ring-white/35 text-white
              "
            >
              {time || "--:--:--"}
            </span>

            <button
              onClick={() => signOut({ callbackUrl: "/" })}
              className="
                inline-flex items-center rounded-md
                px-4 py-2 text-base font-semibold
                bg-white text-blue-700 hover:bg-gray-50
                shadow-sm
                transition
              "
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
