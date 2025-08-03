import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This ensures Vercel uses SSR and avoids pre-rendering API routes
  output: "standalone",

  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },

  reactStrictMode: true,
};

export default nextConfig;
