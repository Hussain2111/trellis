import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Native modules, which must never be bundled.
  serverExternalPackages: ['better-sqlite3', '@resvg/resvg-js', 'node-notifier'],
  typescript: { ignoreBuildErrors: false },
  // Local-first: nothing calls out to an image optimisation service.
  images: { unoptimized: true },
};

export default nextConfig;
