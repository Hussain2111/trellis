import fs from 'node:fs';
import path from 'node:path';
import { normalizeHashtagItems, type HashtagPost } from '../../ingest/normalize';

export { type HashtagPost } from '../../ingest/normalize';

function fixturePath(hashtag: string): string {
  return path.join(process.cwd(), 'fixtures', `hashtag-${hashtag.toLowerCase()}.json`);
}

/** Synchronous fixture/fake hashtag scraping — instant, zero cost, used in fixture/fake SCRAPE_MODE. */
export function scrapeHashtagFixture(hashtag: string, limit: number): HashtagPost[] {
  const file = fixturePath(hashtag);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No fixture for #${hashtag} at ${file}. Run one live scan (SCRAPE_MODE=live) to create it, ` +
        `or switch SCRAPE_MODE=fake to use synthetic data.`,
    );
  }
  const items = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown[];
  return normalizeHashtagItems(Array.isArray(items) ? items : [items]).slice(0, limit);
}

/** Deterministic synthetic hashtag results — a handful of accounts, seeded by the tag itself. */
export function scrapeHashtagFake(hashtag: string, limit: number): HashtagPost[] {
  const seed = hash(hashtag);
  const rng = mulberry32(seed);
  const count = Math.min(limit, 6 + Math.floor(rng() * 6));
  return Array.from({ length: count }, (_, i) => ({
    username: `fake_${hashtag}_${i}`,
    likes: Math.round(200 + rng() * 20000),
    comments: Math.round(10 + rng() * 800),
  }));
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
