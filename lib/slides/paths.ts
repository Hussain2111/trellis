import path from 'node:path';

/**
 * Kept separate from `render.ts` so consumers that only need a path — the asset
 * route, the zip export — don't drag satori and the native resvg binding into
 * their bundle.
 */
export const ASSET_DIR = path.join(process.cwd(), 'data', 'assets');

export function assetDirForDraft(draftId: number): string {
  return path.join(ASSET_DIR, String(draftId));
}
