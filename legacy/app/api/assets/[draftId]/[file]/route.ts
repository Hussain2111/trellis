import fs from 'node:fs';
import path from 'node:path';
import { ASSET_DIR } from '@/lib/slides/paths';

/**
 * Serves rendered slide PNGs — to the local UI, and (via the cloudflared quick
 * tunnel) to Meta, which fetches media over public HTTPS and will not read
 * localhost.
 *
 * Paths are resolved and then checked to be inside ASSET_DIR, so a crafted
 * filename cannot walk out of the assets directory.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ draftId: string; file: string }> },
): Promise<Response> {
  const { draftId, file } = await params;

  const id = Number(draftId);
  if (!Number.isInteger(id) || id <= 0) {
    return new Response('bad draft id', { status: 400 });
  }

  const root = path.resolve(ASSET_DIR, String(id));
  const target = path.resolve(root, path.basename(file));
  if (!target.startsWith(root + path.sep)) {
    return new Response('forbidden', { status: 403 });
  }
  if (!fs.existsSync(target)) {
    return new Response('not found', { status: 404 });
  }

  const bytes = fs.readFileSync(target);
  const ext = path.extname(target).toLowerCase();
  const type = ext === '.mp4' ? 'video/mp4' : ext === '.jpg' ? 'image/jpeg' : 'image/png';

  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': type,
      // Meta may fetch the same URL more than once while a container processes.
      'cache-control': 'public, max-age=300',
    },
  });
}
