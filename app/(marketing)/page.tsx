"use client";

import { useState } from "react";
import { signIn, useSession } from "next-auth/react";

export default function LandingPage() {
  const { status } = useSession();

  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  // Handle signup
  const handleSignup = async (e: React.FormEvent) => {
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
    } catch (err) {
      alert("Error registering user");
    } finally {
      setLoading(false);
    }
  };

  // Handle login
  const handleLogin = async (e: React.FormEvent) => {
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

  return (
    <main className="h-screen w-full flex bg-gray-100">
      {/* Left side - Marketing */}
      <div className="hidden md:flex flex-col justify-center items-center w-1/2 bg-gradient-to-b from-blue-100 to-blue-200 p-10">
        <h1 className="text-4xl font-bold mb-6 text-center">
          Welcome to TheTradersRoom.ai
        </h1>
        <p className="text-lg text-gray-700 text-center max-w-md">
          Track top gainers, get AI stock picks, and manage your daily trades
          all in one place.
        </p>
      </div>

      {/* Right side - Auth form */}
      <div className="flex flex-col justify-center items-center w-full md:w-1/2 p-8">
        <div className="bg-white shadow-lg rounded-lg p-8 w-full max-w-md">
          <h2 className="text-2xl font-bold mb-6 text-center">
            {isLogin ? "Sign In" : "Sign Up"}
          </h2>

          <form
            onSubmit={isLogin ? handleLogin : handleSignup}
            className="flex flex-col gap-4"
          >
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              className="border p-2 rounded"
              required
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="border p-2 rounded"
              required
            />
            <button
              type="submit"
              disabled={loading}
              className={`${
                isLogin
                  ? "bg-blue-600 hover:bg-blue-700"
                  : "bg-green-600 hover:bg-green-700"
              } text-white py-2 rounded transition`}
            >
              {loading
                ? isLogin
                  ? "Signing in..."
                  : "Registering..."
                : isLogin
                ? "Sign In"
                : "Sign Up"}
            </button>
          </form>

          <div className="mt-6 text-center">
            <button
              onClick={() => setIsLogin(!isLogin)}
              className="text-blue-600 hover:underline"
            >
              {isLogin
                ? "Don't have an account? Sign Up"
                : "Already have an account? Sign In"}
            </button>
          </div>

          {/* Google sign-in */}
          <div className="mt-6 text-center">
            <button
              onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
              className="w-full border py-2 rounded hover:bg-gray-50"
            >
              Continue with Google
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
