"use client";

import { useEffect, useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import Image from "next/image";

const PASSKEY = "9340";
const SS_KEY = "sb_pass_ok";

export default function LoginPage() {
  // ── passkey state (hooks always declared unconditionally) ──
  const [passOk, setPassOk] = useState(false);
  const [pass, setPass] = useState("");
  const [passErr, setPassErr] = useState("");

  useEffect(() => {
    try {
      if (typeof window !== "undefined" && sessionStorage.getItem(SS_KEY) === "1") {
        setPassOk(true);
      }
    } catch {/* ignore */}
  }, []);

  const handlePassSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (pass.trim() === PASSKEY) {
      setPassOk(true);
      try { sessionStorage.setItem(SS_KEY, "1"); } catch {/* ignore */}
    } else {
      setPassErr("Incorrect key. Try again.");
    }
  };

  // ── normal login submit ──
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const email = (form.elements.namedItem("email") as HTMLInputElement).value;
    const password = (form.elements.namedItem("password") as HTMLInputElement).value;

    await signIn("credentials", {
      email,
      password,
      callbackUrl: "/", // Redirect after login
    });
  };

  return (
    <div className="relative flex items-center justify-center h-screen bg-gray-100">
      {/* Login card */}
      <div className="bg-white shadow-lg rounded p-8 w-80">
        <h1 className="text-2xl font-bold mb-6 text-center">Login</h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input type="email" name="email" placeholder="Email" required className="border rounded p-2" />
          <input type="password" name="password" placeholder="Password" required className="border rounded p-2" />
          <button type="submit" className="bg-blue-600 text-white py-2 rounded hover:bg-blue-700">
            Sign In
          </button>
        </form>
        <div className="mt-4">
          <button
            onClick={() => signIn("google", { callbackUrl: "/" })}
            className="w-full bg-red-500 text-white py-2 rounded hover:bg-red-600"
          >
            Sign in with Google
          </button>
        </div>
      </div>

      {/* Passkey overlay (same look & feel as before) */}
      {!passOk && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
        >
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl p-6 md:p-8">
            <div className="mb-6 text-center">
              <div className="mx-auto mb-3 h-12 w-12 relative">
                <Image src="/logo4.png" alt="SmartBull logo" fill className="object-contain" />
              </div>
              <h2 className="text-2xl font-bold">Enter Access Key</h2>
              <p className="mt-1 text-sm text-gray-500">This page is gated. Please enter the passkey to continue.</p>
            </div>

            <form onSubmit={handlePassSubmit} className="space-y-4">
              <label className="text-sm block">
                <span className="block text-gray-700 mb-1">Passkey</span>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="\d*"
                  autoFocus
                  value={pass}
                  onChange={(e) => {
                    setPass(e.target.value);
                    setPassErr("");
                  }}
                  placeholder="••••"
                  className="w-full rounded-xl border border-gray-300 px-3 py-2 outline-none focus:ring-2 focus:ring-amber-500"
                  required
                />
              </label>

              {passErr && <p className="text-sm text-red-600">{passErr}</p>}

              <button
                type="submit"
                className="w-full rounded-xl px-4 py-2.5 text-white font-medium bg-black hover:opacity-90"
              >
                Unlock
              </button>
            </form>

            <p className="mt-4 text-center text-xs text-gray-400">Hint: Provided by the admin.</p>
          </div>
        </div>
      )}
    </div>
  );
}
