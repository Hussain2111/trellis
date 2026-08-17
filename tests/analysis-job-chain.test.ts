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
import { registerJobHandlers } from '../lib/jobs/handlers';
import { enqueue } from '../lib/jobs/queue';
import { runTick } from '../lib/jobs/runner';
import { upsertAccount, upsertPosts } from '../lib/ingest/upsert';
import { FakeLlm, __setLlmForTests } from '../lib/providers/llm';
import type { ScrapedPost } from '../lib/providers/scraper/types';

registerJobHandlers();

let fake: FakeLlm;

beforeEach(() => {
  fake = new FakeLlm();
  __setLlmForTests(fake);
});

afterEach(async () => {
  __setLlmForTests(null);
  await db().delete(jobs);
  await db().delete(analyses);
  await db().delete(postFeatures);
  await db().delete(hookLabels);
  await db().delete(posts);
  await db().delete(accounts);
  await db().delete(quotaBudget);
});

afterAll(async () => {
  await closeDb();
});

let n = 0;
const scraped = (likes: number, hasCta = false): ScrapedPost => ({
  shortcode: `J${n++}`,
  type: 'reel',
  caption: hasCta ? 'A hook.\n\nComment "yes" below to get the guide.' : 'A hook.\n\nJust text.',
  takenAt: 1_700_000_000 + n * 3600,
  likes,
  comments: Math.round(likes * 0.05),
  views: null,
  plays: null,
  durationS: null,
  carouselCount: null,
  thumbnailUrl: null,
  mediaUrls: [],
  isSponsored: false,
  raw: {},
});

/**
 * The full deterministic-then-model pipeline, driven purely through the job
 * queue (not by calling handler functions directly) — this is the part the
 * spec explicitly flags as "most likely to break silently on Vercel's
 * function-timeout model": compute_features chains classify_hooks chains
 * run_analysis, entirely via enqueue()/runTick(), with no direct calls.
 */
describe('compute_features -> classify_hooks -> run_analysis (job-queue driven)', () => {
  it('runs the full chain to a persisted analysis with reconciled evidence', async () => {
    const self = await upsertAccount({ handle: 'chainself', role: 'self' });
    await db().update(accounts).set({ followers: 1000 }).where(eq(accounts.id, self.id));
    await upsertPosts(
      self.id,
      Array.from({ length: 4 }, () => scraped(20, false)),
    );

    const competitor = await upsertAccount({ handle: 'chaincompetitor', role: 'competitor' });
    await db().update(accounts).set({ followers: 5000 }).where(eq(accounts.id, competitor.id));
    // classify_hooks processes up to BATCH_SIZE (5) posts per tick before
    // yielding with a real-time delay — keep each account's post count at or
    // under that so this test's single runTick() call sees the whole chain
    // complete rather than a partial batch (the yield/resume behavior itself
    // is covered by tests/jobs-queue.test.ts and tests/discover-competitors.test.ts).
    await upsertPosts(
      competitor.id,
      Array.from({ length: 5 }, () => scraped(900, true)),
    );

    await enqueue('compute_features', { accountId: self.id });
    await enqueue('compute_features', { accountId: competitor.id });

    const result = await runTick(undefined, 15_000);
    expect(result.processed).toBeGreaterThan(0);

    const featureRows = await db().select().from(postFeatures);
    expect(featureRows.length).toBe(9);

    const labelRows = await db().select().from(hookLabels);
    expect(labelRows.length).toBe(9);
    expect(fake.calls.filter((c) => c.operation === 'hook_classification')).toHaveLength(9);

    const analysisRows = await db().select().from(analyses);
    expect(analysisRows).toHaveLength(1);
    expect((analysisRows[0]!.patterns as unknown[]).length).toBeGreaterThan(0);
  });
});
