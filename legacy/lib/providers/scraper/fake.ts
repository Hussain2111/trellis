import type { ProviderHealth } from '../types';
import type {
  CostEstimate,
  ScrapedPost,
  ScrapedProfile,
  ScrapeRequest,
  ScrapeResult,
  ScraperProvider,
} from './types';

/**
 * Deterministic synthetic account. Enough structure (a few archetypes, a couple
 * of genuine outliers, a decayed format) that the analysis layer has something
 * real to find without a single network call.
 */

const ARCHETYPE_HOOKS = [
  'The setting nobody tells you about',
  '3 mistakes killing your reach',
  'I tried this for 30 days',
  'Stop doing this in your first year',
  'The DM funnel that made me',
  'Behind the scenes of a shoot',
];

export class FakeScraper implements ScraperProvider {
  readonly id = 'fake-scraper';
  readonly kind = 'scraper' as const;
  readonly costsMoney = false;
  readonly costNote = 'Synthetic data. No network, no credits.';
  private readonly seed: number;

  constructor(options: { seed?: number } = {}) {
    this.seed = options.seed ?? 42;
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, detail: 'fake scraper is always healthy' };
  }

  async estimate(request: { handle: string; limit: number }): Promise<CostEstimate> {
    return {
      items: request.limit,
      costUsd: 0,
      remainingAfterUsd: Number.POSITIVE_INFINITY,
      affordable: true,
      note: 'Fake scraper — no credits are spent.',
    };
  }

  async scrape(request: ScrapeRequest): Promise<ScrapeResult> {
    const rng = mulberry32(this.seed + hash(request.handle));
    const profile: ScrapedProfile = {
      handle: request.handle,
      igUserId: String(1000000 + Math.floor(rng() * 8999999)),
      fullName: request.handle.replace(/[._]/g, ' '),
      bio: 'Synthetic account for offline development.',
      followers: 4000 + Math.floor(rng() * 40000),
      following: 200 + Math.floor(rng() * 800),
      postsCount: request.limit,
      isVerified: false,
    };

    const posts: ScrapedPost[] = [];
    const dayS = 86400;
    const nowS = Math.floor(Date.now() / 1000);

    for (let i = 0; i < request.limit; i++) {
      // Keyed on a hash of the full handle: truncating the handle made
      // different competitors collide on the unique shortcode index.
      const shortcode = `FAKE${hash(request.handle).toString(36).toUpperCase().slice(0, 6)}${String(i).padStart(4, '0')}`;
      if (request.stopAtShortcodes?.has(shortcode)) break;

      const archetype = Math.floor(rng() * ARCHETYPE_HOOKS.length);
      const type = pickType(rng(), i);
      // A DM-funnel archetype that stopped 45 days ago — the decay signal.
      const takenAt = nowS - i * 2 * dayS;
      const decayed = archetype === 4 && takenAt > nowS - 45 * dayS;
      const base = 200 + rng() * 400;
      const outlier = i % 23 === 0 ? 6 : 1;

      posts.push({
        shortcode,
        type,
        caption: `${ARCHETYPE_HOOKS[decayed ? 0 : archetype]}\n\nSynthetic caption body for post ${i}.\n\n#photography #tips #behindthescenes`,
        takenAt,
        likes: Math.round(base * outlier),
        comments: Math.round(base * outlier * 0.04),
        views: type === 'reel' ? Math.round(base * outlier * 22) : null,
        plays: type === 'reel' ? Math.round(base * outlier * 24) : null,
        durationS: type === 'reel' ? 12 + Math.round(rng() * 40) : null,
        carouselCount: type === 'carousel' ? 3 + Math.floor(rng() * 6) : null,
        thumbnailUrl: null,
        mediaUrls: [],
        isSponsored: false,
        raw: { synthetic: true, index: i, archetype },
      });
      request.onProgress?.(posts.length, `synthesised ${posts.length}/${request.limit}`);
    }

    return {
      profile,
      posts,
      complete: true,
      note: 'Synthetic data from FakeScraper.',
      itemsCharged: 0,
      costEstimateUsd: 0,
      raw: { synthetic: true },
    };
  }
}

function pickType(r: number, i: number): ScrapedPost['type'] {
  if (i % 7 === 0) return 'carousel';
  return r < 0.55 ? 'reel' : r < 0.85 ? 'image' : 'carousel';
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
