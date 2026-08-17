import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { env } from '../env';
import { appUrl } from '../app-url';

export interface StoredAsset {
  storagePath: string;
  publicUrl: string;
}

/**
 * Vercel functions have no persistent filesystem, so rendered slide PNGs go
 * to Supabase Storage in production. Without Supabase credentials configured
 * (local dev, or this build before a real Supabase project exists), this
 * falls back to writing under ./data/assets and serving it back through
 * /api/assets/[...path] — a dev convenience, not a second production path.
 */
export async function uploadAsset(
  assetPath: string,
  bytes: Buffer,
  contentType: string,
): Promise<StoredAsset> {
  const e = env();
  if (e.SUPABASE_URL && e.SUPABASE_SERVICE_ROLE_KEY) {
    const client = createClient(e.SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY);
    const { error } = await client.storage
      .from(e.SUPABASE_STORAGE_BUCKET)
      .upload(assetPath, bytes, { contentType, upsert: true });
    if (error) throw new Error(`Supabase Storage upload failed: ${error.message}`);
    const { data } = client.storage.from(e.SUPABASE_STORAGE_BUCKET).getPublicUrl(assetPath);
    return { storagePath: assetPath, publicUrl: data.publicUrl };
  }

  return uploadLocal(assetPath, bytes);
}

const LOCAL_ASSET_DIR = path.join(process.cwd(), 'data', 'assets');

function uploadLocal(assetPath: string, bytes: Buffer): StoredAsset {
  const file = path.join(LOCAL_ASSET_DIR, assetPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return { storagePath: assetPath, publicUrl: `${appUrl()}/api/assets/${assetPath}` };
}

export function readLocalAsset(assetPath: string): Buffer | null {
  const file = path.join(LOCAL_ASSET_DIR, assetPath);
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(LOCAL_ASSET_DIR))) return null; // path traversal guard
  if (!fs.existsSync(resolved)) return null;
  return fs.readFileSync(resolved);
}
