"use client";

import { signIn } from "next-auth/react";

export default function LoginPage() {
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
    <div className="flex items-center justify-center h-screen bg-gray-100">
      <div className="bg-white shadow-lg rounded p-8 w-80">
        <h1 className="text-2xl font-bold mb-6 text-center">Login</h1>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="email"
            name="email"
            placeholder="Email"
            required
            className="border rounded p-2"
          />
          <input
            type="password"
            name="password"
            placeholder="Password"
            required
            className="border rounded p-2"
          />
          <button
            type="submit"
            className="bg-blue-600 text-white py-2 rounded hover:bg-blue-700"
          >
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
    </div>
  );
}
