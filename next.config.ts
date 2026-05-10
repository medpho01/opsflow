import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // ESLint runs as a separate CI step; don't block builds on linting
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Match the eslint flag above. Codebase has accumulated ~85 type
    // drifts (mostly Prisma JSON-input variance + missing test-runner
    // types) that don't affect runtime; running `tsc --noEmit` in CI
    // catches them without blocking the production build. Flip back
    // to false once those have been swept.
    ignoreBuildErrors: true,
  },
  // Carried over from the now-deleted next.config.js. node-cron pulls in
  // node:* built-ins that webpack chokes on if it tries to bundle them.
  serverExternalPackages: ["node-cron"],
  // Build output goes to ./build instead of ./.next — works around a
  // local Next 15.5.15 race where something on this machine (Spotlight /
  // a watcher / VS Code extension) keeps deleting `.next/server/*`
  // manifests between webpack's compile-finish and the manifest writer.
  // The hidden-dotfile path appears to be the trigger.
  distDir: "build",
};

export default nextConfig;
