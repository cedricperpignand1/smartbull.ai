"use client";

import Image from "next/image";
import { useEffect, useState, type FormEvent } from "react";
import { signIn, useSession } from "next-auth/react";
import BookViewer, { type BookPage } from "../components/BookViewer";

const PASSKEY = "9340";
const SS_KEY = "sb_pass_ok";

export default function LandingPage() {
  // Always call hooks in the same order on every render ↓
  const { status } = useSession();

  // Passkey gate
  const [passOk, setPassOk] = useState(false);
  const [pass, setPass] = useState("");
  const [passErr, setPassErr] = useState("");

  // Auth form state
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  // Lightbox state
  const [showDash, setShowDash] = useState(false);

  // Effects (also unconditional)
  useEffect(() => {
    try {
      if (typeof window !== "undefined" && sessionStorage.getItem(SS_KEY) === "1") {
        setPassOk(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setShowDash(false);
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, []);

  // Handlers
  const handlePassSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (pass.trim() === PASSKEY) {
      setPassOk(true);
      try {
        sessionStorage.setItem(SS_KEY, "1");
      } catch { /* ignore */ }
    } else {
      setPassErr("Incorrect key. Try again.");
    }
  };

  const handleSignup = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.message || "Failed to register");
        return;
      }
      alert("Registration successful! You can now log in.");
      setIsLogin(true);
    } catch {
      alert("Error registering user");
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await signIn("credentials", {
        redirect: true,
        email,
        password,
        callbackUrl: "/dashboard",
      });
    } finally {
      setLoading(false);
    }
  };

  // Static content
  const PAGES: BookPage[] = [
    {
      title: "The Truth",
      content: (
        <>
          <p>
            The truth is… as much as you want to believe you can “know” a stock’s next move, you never will.
            No one knows the a price before it happens — not gurus, not analysts, not the news.
          </p>
          <p>
            The market is driven by probabilities, not certainties. And here’s something even more important:
            around 70% of the market is algorithms. These are machines programmed to trade faster, smarter,
            and without emotion. You can’t “fight” them. You’re a human — emotional, hesitant, influenced by fear and greed.
            They are not.
          </p>
          <p>
            So instead of battling algorithms, the best day traders learn to play with probabilities.
            Don’t obsess over the stock itself — focus on the setup, the volume, and the ability to enter and exit instantly.
          </p>
          <p>Liquidity is king. Without it, you can’t fill your position fast enough to win.</p>
        </>
      ),
    },
    {
      title: "Why Volume Matters",
      content: (
        <>
          <p>
            When day trading, your edge isn’t in predicting exactly where a stock will go — it’s in choosing the right playing field.
          </p>
          <p>
            You need stocks that are liquid enough so your buy or sell order is filled instantly, whether you’re going long or short.
            If there’s no volume, you’re stuck — and stuck is the worst place to be in a fast-moving market.
          </p>
          <p>
            This is why seasoned traders don’t waste time on low-volume “hope” plays. They find the right candidates
            and trade only when the odds are in their favor.
          </p>
          <p>And that’s where SmartBull comes in.</p>
        </>
      ),
    },
    {
      title: "How SmartBull Can Help You",
      content: (
        <>
          <p>
            SmartBull focuses on long positions only. We do this for one reason: to help traders who are just starting out.
            Shorting can be dangerous, and beginners often lose big before they understand the risks.
          </p>
          <p>
            Instead, SmartBull uses the power of AI to scan all top gainers of the day. Then, it chooses the single best
            candidate for a high-probability long trade.
          </p>
          <p>
            We target stocks with potential to move 10% up or down. Why? Because this makes the trade realistic for small accounts.
            A trader with $4,000 in a high-market-cap stock won’t make much unless they use margin — and margin is a fast way to blow up.
          </p>
          <p>Our AI helps you find plays where small size can still mean big percentage gains.</p>
        </>
      ),
    },
    {
      title: "The SmartBull Experience",
      content: (
        <>
          <p>
            When you log in to SmartBull AI, you’re not just looking at a static list of tickers. You’re watching an AI trade in real time.
          </p>
          <p>You can talk to it.</p>
          <p>You can see what it’s trading today.</p>
          <p>You can ask why it’s interested in a specific stock.</p>
          <p>You can view its live PnL to track performance.</p>
          <p>
            It’s important to remember: no one — and nothing — will be right every time. Not traders, not algorithms, not even SmartBull.
            That’s the game of life — things change too quickly in real time for anyone to win 100% of the time.
          </p>
          <p>The goal isn’t perfection — the goal is consistent, disciplined execution over time.</p>
          <p>
            SmartBull isn’t a financial advisor — it’s a guide, a tool to help you narrow your focus and improve your decision-making.
          </p>
        </>
      ),
    },
    {
      title: "Final Word",
      content: (
        <>
          <p>
            The market is a game of probabilities. The truth is, you’ll never “beat” the algorithms — but you can use their patterns to your advantage.
          </p>
          <p>
            SmartBull exists to level the playing field for small traders. We cut through the noise, highlight the right opportunities,
            and let you see exactly how AI approaches the market.
          </p>
          <p>It’s not about chasing every move. It’s about taking the right move, at the right time, in the right stock.</p>
          <p>Your job: Stay disciplined, trade smart, and let SmartBull help you see the game more clearly.</p>
        </>
      ),
    },
  ];

  // UI (gate just switches what we render; hooks above stay the same every render)
  return (
    <>
      {!passOk ? (
        <main className="min-h-screen w-full bg-gradient-to-b from-sky-50 via-blue-50 to-slate-100 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl p-6 md:p-8 ring-1 ring-slate-200">
            <div className="mb-6 text-center">
              <Image src="/logo4.png" alt="SmartBull logo" width={48} height={48} className="mx-auto mb-3" />
              <h1 className="text-2xl font-bold">Enter Access Key</h1>
              <p className="mt-1 text-sm text-slate-500">This page is gated. Please enter the passkey to continue.</p>
            </div>

            <form onSubmit={handlePassSubmit} className="space-y-4">
              <label className="text-sm block">
                <span className="block text-slate-700 mb-1">Passkey</span>
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
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-sky-400"
                  required
                />
              </label>

              {passErr && <p className="text-sm text-red-600">{passErr}</p>}

              <button
                type="submit"
                className="w-full rounded-xl px-4 py-2.5 text-white font-medium bg-blue-600 hover:bg-blue-700"
              >
                Unlock
              </button>
            </form>

            <p className="mt-4 text-center text-xs text-slate-400">Hint: Provided by the admin.</p>
          </div>
        </main>
      ) : (
        <main className="min-h-screen w-full relative flex items-center justify-center p-4 bg-gradient-to-b from-sky-50 via-blue-50 to-slate-100">
          {/* soft radial blue glow background */}
          <div className="pointer-events-none absolute inset-0 [background:radial-gradient(60%_50%_at_50%_10%,rgba(56,189,248,0.25),transparent)]" />

          <div className="relative w-full max-w-6xl">
            {/* soft outer glow */}
            <div className="absolute -inset-2 rounded-[28px] bg-gradient-to-br from-sky-200/60 to-blue-300/50 blur" />

            <div className="relative bg-white rounded-[24px] shadow-2xl overflow-hidden ring-1 ring-slate-200">
              {/* Book spine effect for top section */}
              <div className="pointer-events-none absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-gradient-to-b from-slate-200 via-slate-100 to-slate-200 shadow-inner" />
              <div className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 w-32 bg-gradient-to-r from-black/5 via-transparent to-black/5" />

              {/* === TOP: hero + auth === */}
              <div className="grid grid-cols-1 md:grid-cols-2">
                {/* LEFT: welcome */}
                <section className="relative p-8 md:p-12 bg-gradient-to-b from-sky-50 to-white flex">
                  <div className="absolute bottom-6 left-8 text-xs text-slate-400 select-none">
                    SmartBull · I
                  </div>

                  <div className="m-auto md:m-0 max-w-md">
                    <div className="mb-8 flex items-center gap-4">
                      <Image
                        src="/logo4.png"
                        alt="SmartBull logo"
                        width={96}
                        height={96}
                        className="h-20 w-20 object-contain drop-shadow animate-[spin_12s_linear_infinite]"
                        priority
                      />
                      <div>
                        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-slate-900">
                          Welcome to <span className="text-blue-600">SmartBull.ai</span>
                        </h1>
                        <p className="mt-2 text-slate-600">
                          Track top gainers, get AI stock picks, and manage your daily trades in one place.
                        </p>
                      </div>
                    </div>

                    <ul className="list-disc pl-6 text-slate-700 space-y-2">
                      <li>Live top gainers & high relative volume</li>
                      <li>AI scoring: float, market cap, headlines</li>
                      <li>Quick entries with targets & risk</li>
                    </ul>

                    {/* Thumbnail under bullets */}
                    <div className="mt-6">
                      <button
                        type="button"
                        onClick={() => setShowDash(true)}
                        className="group block rounded-xl overflow-hidden ring-1 ring-slate-200 hover:ring-slate-300 shadow hover:shadow-lg transition"
                        aria-label="Open SmartBull dashboard preview"
                      >
                        <Image
                          src="/dashboard1.png"
                          alt="SmartBull dashboard preview"
                          width={1200}
                          height={700}
                          className="w-full h-auto object-cover group-active:scale-[0.99] transition"
                          priority
                        />
                      </button>
                      <p className="mt-2 text-sm text-slate-500">Click to enlarge</p>
                    </div>
                  </div>
                </section>

                {/* RIGHT: sign in / sign up */}
                <section className="relative p-8 md:p-12 bg-white">
                  <div className="absolute bottom-6 right-8 text-xs text-slate-400 select-none">
                    {isLogin ? "Sign In" : "Sign Up"} · II
                  </div>

                  <div className="mx-auto w-full max-w-md">
                    <h2 className="text-2xl font-bold mb-6 text-center">
                      {isLogin ? "Sign In" : "Sign Up"}
                    </h2>

                    <form onSubmit={isLogin ? handleLogin : handleSignup} className="flex flex-col gap-4">
                      <label className="text-sm">
                        <span className="block text-slate-700 mb-1">Email</span>
                        <input
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="you@example.com"
                          className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-sky-400"
                          required
                        />
                      </label>

                      <label className="text-sm">
                        <span className="block text-slate-700 mb-1">Password</span>
                        <input
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="••••••••"
                          className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-sky-400"
                          required
                        />
                      </label>

                      <button
                        type="submit"
                        disabled={loading || status === "loading"}
                        className={`w-full rounded-xl px-4 py-2.5 text-white font-medium transition
                          ${isLogin ? "bg-blue-600 hover:bg-blue-700" : "bg-cyan-600 hover:bg-cyan-700"}
                          disabled:opacity-60`}
                      >
                        {loading ? (isLogin ? "Signing in..." : "Registering...") : isLogin ? "Sign In" : "Sign Up"}
                      </button>
                    </form>

                    <div className="my-6 flex items-center gap-4">
                      <div className="h-px flex-1 bg-slate-200" />
                      <span className="text-xs text-slate-400 uppercase tracking-wider">or</span>
                      <div className="h-px flex-1 bg-slate-200" />
                    </div>

                    <button
                      onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
                      className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-slate-800 font-medium hover:bg-slate-50"
                    >
                      Continue with Google
                    </button>

                    <div className="mt-6 text-center">
                      <button
                        onClick={() => setIsLogin(!isLogin)}
                        className="text-blue-700 hover:underline"
                      >
                        {isLogin ? "Don't have an account? Sign Up" : "Already have an account? Sign In"}
                      </button>
                    </div>
                  </div>
                </section>
              </div>

              {/* === BOTTOM: Full-width Book section === */}
              <section className="border-t border-slate-200 bg-white">
                <div className="px-6 py-10 md:px-12">
                  <h3 className="text-xl md:text-3xl font-semibold text-slate-900 mb-4">
                    Please Read Before you Proceed
                  </h3>
                  <p className="text-slate-600 mb-8">A quick overview on Smartbull.ai.</p>

                  <BookViewer pages={PAGES} className="max-w-3xl w-full" />
                </div>
              </section>
            </div>
          </div>

          {/* --- Lightbox Modal --- */}
          {showDash && (
            <div
              role="dialog"
              aria-modal="true"
              className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
              onClick={() => setShowDash(false)}
            >
              <div className="relative w-full max-w-6xl" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => setShowDash(false)}
                  className="absolute -top-3 -right-3 rounded-full bg-white/90 text-black px-3 py-1 text-sm font-medium shadow hover:bg-white"
                  aria-label="Close"
                >
                  Close
                </button>
                <Image
                  src="/dashboard.png"
                  alt="SmartBull dashboard large preview"
                  width={1920}
                  height={1080}
                  className="w-full h-auto rounded-xl shadow-2xl"
                  priority
                />
              </div>
            </div>
          )}
        </main>
      )}
    </>
  );
}
