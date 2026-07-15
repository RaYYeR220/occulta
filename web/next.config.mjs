import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Pin the trace root to this app: a stray lockfile elsewhere on the machine otherwise makes
  // Next.js guess the workspace root, which is noisy and irrelevant to this standalone app.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
