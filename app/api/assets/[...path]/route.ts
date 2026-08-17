import { readLocalAsset } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/**
 * Dev-only fallback asset server. Only reachable at all when Supabase
 * Storage isn't configured (see lib/storage/index.ts) — production serves
 * rendered slides directly from Supabase's public bucket URL instead.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path: segments } = await context.params;
  const assetPath = segments.join('/');
  const bytes = readLocalAsset(assetPath);
  if (!bytes) return new Response('not found', { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
