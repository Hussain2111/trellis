import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import {
  accounts,
  analyses,
  drafts,
  hookLabels,
  jobs,
  postFeatures,
  posts,
  quotaBudget,
  voiceProfile,
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
  await db().delete(drafts);
  await db().delete(analyses);
  await db().delete(voiceProfile);
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
const scraped = (likes: number, hasCta: boolean): ScrapedPost => ({
  shortcode: `V${n++}`,
  type: 'reel',
  // topCaptionsForVoice only counts captions over 40 chars — keep these
  // comfortably past that so the voice-profile step actually has input.
  caption: hasCta
    ? 'A hook that goes on a bit.\n\nComment "yes" below to get the guide.'
    : 'A hook that goes on a bit.\n\nJust some more body text here.',
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
 * The whole automatic chain, driven purely by the job queue: run_analysis
 * (already proven in tests/analysis-job-chain.test.ts) additionally chains
 * build_voice_profile, which chains generate_drafts against the analysis it
 * just produced.
 */
describe('run_analysis -> build_voice_profile -> generate_drafts', () => {
  it('ends with a saved voice profile and generated drafts, both traceable to the analysis', async () => {
    const self = await upsertAccount({ handle: 'chainvoice', role: 'self' });
    await db().update(accounts).set({ followers: 1000 }).where(eq(accounts.id, self.id));
    await upsertPosts(
      self.id,
      Array.from({ length: 4 }, () => scraped(20, false)),
    );

    const competitor = await upsertAccount({ handle: 'chaincompetitor2', role: 'competitor' });
    await db().update(accounts).set({ followers: 5000 }).where(eq(accounts.id, competitor.id));
    await upsertPosts(
      competitor.id,
      Array.from({ length: 5 }, () => scraped(900, true)),
    );

    await enqueue('compute_features', { accountId: self.id });
    await enqueue('compute_features', { accountId: competitor.id });

    // Several ticks: compute_features -> classify_hooks -> run_analysis ->
    // build_voice_profile -> generate_drafts, each a real job-queue hop.
    let totalProcessed = 0;
    for (let i = 0; i < 6; i++) {
      const result = await runTick(undefined, 10_000);
      totalProcessed += result.processed;
      const [analysis] = await db().select().from(analyses);
      const [voice] = await db().select().from(voiceProfile);
      const draftRows = await db().select().from(drafts);
      if (analysis && voice && draftRows.length > 0) break;
    }

    expect(totalProcessed).toBeGreaterThan(0);

    const [analysis] = await db().select().from(analyses);
    expect(analysis).toBeDefined();

    const [voice] = await db().select().from(voiceProfile);
    expect(voice).toBeDefined();
    expect(voice?.active).toBe(true);

    const draftRows = await db().select().from(drafts);
    expect(draftRows.length).toBeGreaterThan(0);
    for (const draft of draftRows) {
      expect(draft.analysisId).toBe(analysis!.id);
      expect(['carousel', 'reel', 'image']).toContain(draft.format);
    }
  });
});
