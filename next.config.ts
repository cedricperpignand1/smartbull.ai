import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ensure that Next.js uses SSR for dynamic routes (important for NextAuth)
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
  reactStrictMode: true,
};

export default nextConfig;
