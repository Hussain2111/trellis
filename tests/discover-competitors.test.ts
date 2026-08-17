import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, jobs, posts, quotaBudget } from '../lib/db/schema';
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
  fake.queue(JSON.stringify({ niche: 'test niche', description: 'a'.repeat(30) }));
  __setLlmForTests(fake);
});

afterEach(async () => {
  __setLlmForTests(null);
  await db().delete(jobs);
  await db().delete(posts);
  await db().delete(accounts);
  await db().delete(quotaBudget);
});

afterAll(async () => {
  await closeDb();
});

const post = (caption: string, shortcode: string): ScrapedPost => ({
  shortcode,
  type: 'reel',
  caption,
  takenAt: 1_700_000_000,
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
});

/**
 * fixtures/hashtag-niche1.json and hashtag-niche2.json back this test — see
 * their contents for the accounts and engagement numbers being ranked.
 */
describe('discover_competitors (fixture mode, the full fire → yield → children → rank pipeline)', () => {
  it('infers the niche, discovers competitors ranked by engagement, and chains scans for them', async () => {
    const account = await upsertAccount({ handle: 'testaccount', role: 'self' });
    await upsertPosts(account.id, [
      post('hook one #niche1 #niche1', 'P1'),
      post('hook two #niche1', 'P2'),
      post('hook three #niche2', 'P3'),
    ]);

    await enqueue('discover_competitors', { accountId: account.id });
    const result = await runTick(['discover_competitors', 'scan_hashtag', 'scan_account'], 10_000);

    // parent (pass 1) + 2 hashtag children + parent (pass 2, completes) = 4,
    // plus a scan_account per discovered competitor.
    expect(result.processed).toBeGreaterThanOrEqual(4);

    const [refreshedSelf] = await db().select().from(accounts).where(eq(accounts.id, account.id));
    expect(refreshedSelf?.niche).toBe('test niche');

    const competitors = await db().select().from(accounts).where(eq(accounts.role, 'competitor'));
    const handles = competitors.map((c) => c.handle).sort();
    // bigcreator and midcreator dominate by engagement across both hashtags;
    // testaccount (the self handle appearing in the niche1 fixture) must be
    // excluded from its own discovery results.
    expect(handles).toContain('bigcreator');
    expect(handles).toContain('midcreator');
    expect(handles).not.toContain('testaccount');

    const bigcreator = competitors.find((c) => c.handle === 'bigcreator');
    expect(bigcreator?.discoveredViaHashtag).toBe('niche1');

    const chainedScans = await db().select().from(jobs).where(eq(jobs.type, 'scan_account'));
    expect(chainedScans.length).toBe(competitors.length);
  });

  it('completes cleanly with no competitors when the account has no hashtags', async () => {
    const account = await upsertAccount({ handle: 'notags', role: 'self' });
    await upsertPosts(account.id, [post('just a caption, no tags', 'Q1')]);

    await enqueue('discover_competitors', { accountId: account.id });
    await runTick(['discover_competitors'], 5_000);

    const competitors = await db().select().from(accounts).where(eq(accounts.role, 'competitor'));
    expect(competitors).toHaveLength(0);
  });
});
