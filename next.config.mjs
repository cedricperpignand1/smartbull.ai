/** @type {import('next').NextConfig} */
const nextConfig = {
  // Ensures Vercel packs a minimal server; safe for Next 13/14+
  output: "standalone",

  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },

  reactStrictMode: true,

  // Ignore build-time TS errors on Vercel (optional)
  typescript: {
    ignoreBuildErrors: true,
  },

  // Ignore ESLint errors on Vercel (optional)
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
