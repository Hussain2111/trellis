import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Native module — must never be bundled.
  serverExternalPackages: ['@resvg/resvg-js'],
  typescript: { ignoreBuildErrors: false },
  // No Instagram OAuth, no external image host — served via Supabase Storage
  // public URLs, which don't need Next's optimizer.
  images: { unoptimized: true },
};

export default nextConfig;
