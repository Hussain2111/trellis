import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module: it must never be bundled.
  serverExternalPackages: ['better-sqlite3'],
  typescript: { ignoreBuildErrors: false },
  // Local-first: nothing calls out to an image optimisation service.
  images: { unoptimized: true },
};

export default nextConfig;
