import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import {
  accounts,
  analyses,
  hookLabels,
  jobs,
  postFeatures,
  posts,
  quotaBudget,
} from '../lib/db/schema';
import { persistFeatures } from '../lib/analysis/features';
import { InsufficientData, runPatternAnalysis } from '../lib/analysis/analysis';
import { reconcilePatterns } from '../lib/analysis/reconcile';
import { loadCorpus } from '../lib/analysis/corpus';
import { upsertAccount, upsertPosts } from '../lib/ingest/upsert';
import { FakeLlm, __setLlmForTests } from '../lib/providers/llm';
import type { ScrapedPost } from '../lib/providers/scraper/types';

let fake: FakeLlm;

beforeEach(() => {
  fake = new FakeLlm();
  __setLlmForTests(fake);
});

afterEach(async () => {
  __setLlmForTests(null);
  await db().delete(jobs);
  await db().delete(postFeatures);
  await db().delete(hookLabels);
  await db().delete(analyses);
  await db().delete(posts);
  await db().delete(accounts);
  await db().delete(quotaBudget);
});

afterAll(async () => {
  await closeDb();
});

let n = 0;
const scraped = (overrides: Partial<ScrapedPost> = {}): ScrapedPost => ({
  shortcode: `SC${n++}`,
  type: 'reel',
  caption: 'A caption\n\n#tag',
  takenAt: 1_700_000_000 + n * 3600,
  likes: 100,
  comments: 5,
  views: null,
  plays: null,
  durationS: null,
  carouselCount: null,
  thumbnailUrl: null,
  mediaUrls: [],
  isSponsored: false,
  raw: {},
  ...overrides,
});

async function seedAccount(
  handle: string,
  role: 'self' | 'competitor',
  followers: number,
  count: number,
  likes: number,
  hasCta = false,
) {
  const account = await upsertAccount({ handle, role });
  await db().update(accounts).set({ followers }).where(eq(accounts.id, account.id));
  const scrapedPosts = Array.from({ length: count }, () =>
    scraped({
      likes,
      caption: hasCta ? 'Great tip.\n\nComment "yes" below to get the guide.' : 'Just a caption.',
    }),
  );
  await upsertPosts(account.id, scrapedPosts);
  await persistFeatures(account.id, followers, 2.5);
  return account;
}

async function labelAllHooks(accountId: number, category: string) {
  const rows = await db()
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.accountId, accountId));
  for (const row of rows) {
    await db()
      .insert(hookLabels)
      .values({ postId: row.id, category, confidence: 0.9, generatedBy: 'test' });
  }
}

describe('runPatternAnalysis', () => {
  it('throws InsufficientData with no competitor posts', async () => {
    await seedAccount('soloself', 'self', 1000, 5, 100);
    await expect(runPatternAnalysis(30)).rejects.toThrow(InsufficientData);
  });

  it('computes patterns, passes reconciliation, and persists the analysis', async () => {
    const self = await seedAccount('me', 'self', 1000, 6, 50, false);
    const competitor = await seedAccount('winner', 'competitor', 5000, 8, 900, true);
    await labelAllHooks(self.id, 'other');
    await labelAllHooks(competitor.id, 'bold_claim');

    const result = await runPatternAnalysis(30);

    expect(result.patterns.length).toBeGreaterThan(0);

    const corpus = await loadCorpus();
    expect(reconcilePatterns(result.patterns, corpus)).toEqual([]);

    const [stored] = await db().select().from(analyses).where(eq(analyses.id, result.id));
    expect(stored).toBeDefined();
    expect((stored!.patterns as unknown[]).length).toBe(result.patterns.length);
    // v2 stopped writing the single-biggest-gap payload; the column stays
    // nullable only so v1's historical rows keep their receipts.
    expect(stored!.gap).toBeNull();
  });

  it('uses the LLM claim when it correctly cites both stats', async () => {
    await seedAccount('me2', 'self', 1000, 4, 10, false);
    await seedAccount('winner2', 'competitor', 5000, 8, 900, true);

    // has_cta will be the dominant pattern: niche 100%, self 0%.
    fake.queue(
      JSON.stringify({
        claims: [
          { key: 'has_cta', claim: '100% of top performers use a CTA, you use it 0% of the time.' },
        ],
      }),
    );

    const result = await runPatternAnalysis(30);
    const ctaPattern = result.patterns.find((p) => p.key === 'has_cta')!;
    expect(ctaPattern.claim).toContain('100%');
    expect(ctaPattern.claim).toContain('0%');
  });

  it('falls back to a deterministic claim when the LLM invents numbers', async () => {
    await seedAccount('me3', 'self', 1000, 4, 10, false);
    await seedAccount('winner3', 'competitor', 5000, 8, 900, true);

    fake.queue(
      JSON.stringify({
        claims: [
          { key: 'has_cta', claim: 'Roughly a third of top performers use a CTA, you rarely do.' },
        ],
      }),
    );

    const result = await runPatternAnalysis(30);
    const ctaPattern = result.patterns.find((p) => p.key === 'has_cta')!;
    // The deterministic template always states the exact percentages, even
    // though the model call itself succeeded — only this claim's numbers
    // failed validation, so only this claim falls back.
    expect(ctaPattern.claim).toMatch(/\d+% of top performers/);
    expect(ctaPattern.claim).toContain('100%');
    expect(ctaPattern.claim).toContain('0%');
  });

  it('falls back to deterministic claims when the LLM call throws entirely', async () => {
    await seedAccount('me4', 'self', 1000, 4, 10, false);
    await seedAccount('winner4', 'competitor', 5000, 8, 900, true);
    fake.queue('not json');
    fake.queue('still not json');

    const result = await runPatternAnalysis(30);
    expect(result.patterns.every((p) => p.claim.length > 0)).toBe(true);
  });
});
