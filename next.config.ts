import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ensures Vercel uses SSR and avoids pre-rendering API routes
  output: "standalone",

  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },

  reactStrictMode: true,

  // Skip type errors during build (Vercel)
  typescript: {
    ignoreBuildErrors: true,
  },

  // Skip ESLint errors during build (Vercel)
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
