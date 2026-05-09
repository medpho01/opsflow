import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // ESLint runs as a separate CI step; don't block builds on linting
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Type errors are caught in CI; allow production builds to proceed
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
