import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, posts } from '../lib/db/schema';
import { hotTopics, MIN_POSTS_FOR_TREND } from '../lib/analytics/topics';
import { upsertAccount } from '../lib/ingest/upsert';

afterEach(async () => {
  await db().delete(posts);
  await db().delete(accounts);
});

afterAll(async () => {
  await closeDb();
});

let n = 0;
async function seed(
  accountId: number,
  caption: string | null,
  daysAgo: number | null,
  likes = 100,
) {
  await db()
    .insert(posts)
    .values({
      accountId,
      shortcode: `T${++n}`,
      type: 'image',
      caption,
      likes,
      comments: 0,
      takenAt: daysAgo == null ? null : new Date(Date.now() - daysAgo * 86_400_000),
      raw: {},
    });
}

describe('hotTopics', () => {
  it('measures movement in share of posts, not raw count', async () => {
    const account = await upsertAccount({ handle: 'top1', role: 'competitor' });

    // Prior window: 10 posts, 5 use #steady → 50% share.
    for (let i = 0; i < 5; i++) await seed(account.id, '#steady', 40);
    for (let i = 0; i < 5; i++) await seed(account.id, '#other', 40);

    // Recent window: 4 posts, 3 use #steady → 75% share. Fewer posts using it
    // in absolute terms would be a fall; as a share it is a rise.
    for (let i = 0; i < 3; i++) await seed(account.id, '#steady', 5);
    await seed(account.id, '#other', 5);

    const result = await hotTopics({ windowDays: 30 });
    const steady = result.rising.find((t) => t.tag === 'steady')!;
    expect(steady.recentPosts).toBe(3);
    expect(steady.priorPosts).toBe(5);
    expect(steady.recentShare).toBeCloseTo(0.75);
    expect(steady.priorShare).toBeCloseTo(0.5);
    expect(steady.shareDeltaPct).toBeCloseTo(25);
  });

  it('drops tags below the noise floor', async () => {
    const account = await upsertAccount({ handle: 'top2', role: 'competitor' });
    for (let i = 0; i < MIN_POSTS_FOR_TREND - 1; i++) await seed(account.id, '#rare', 5);
    for (let i = 0; i < MIN_POSTS_FOR_TREND; i++) await seed(account.id, '#common', 5);

    const result = await hotTopics();
    const tags = [...result.rising, ...result.strongest].map((t) => t.tag);
    expect(tags).not.toContain('rare');
    expect(tags).toContain('common');
  });

  it('leaves share change null when there is no prior window to compare against', async () => {
    const account = await upsertAccount({ handle: 'top3', role: 'competitor' });
    for (let i = 0; i < 3; i++) await seed(account.id, '#new', 5);

    const result = await hotTopics();
    const topic = result.strongest.find((t) => t.tag === 'new')!;
    // No prior posts at all — that is not the same as "no change".
    expect(topic.shareDeltaPct).toBeNull();
    expect(result.rising).toHaveLength(0);
  });

  it('counts a tag once per post however many times the caption repeats it', async () => {
    const account = await upsertAccount({ handle: 'top4', role: 'competitor' });
    for (let i = 0; i < 3; i++) await seed(account.id, '#spam #spam #spam', 5);

    const result = await hotTopics();
    expect(result.strongest.find((t) => t.tag === 'spam')!.recentPosts).toBe(3);
  });

  it('ignores posts with no timestamp rather than treating them as recent', async () => {
    const account = await upsertAccount({ handle: 'top5', role: 'competitor' });
    for (let i = 0; i < 3; i++) await seed(account.id, '#undated', null);

    const result = await hotTopics();
    expect(result.recentPostCount).toBe(0);
    expect(result.strongest).toHaveLength(0);
  });

  it('rates a tag against the pool median and counts how many accounts use it', async () => {
    const a = await upsertAccount({ handle: 'top6a', role: 'competitor' });
    const b = await upsertAccount({ handle: 'top6b', role: 'competitor' });
    for (let i = 0; i < 3; i++) await seed(a.id, '#hot', 5, 400);
    for (let i = 0; i < 3; i++) await seed(b.id, '#hot', 5, 400);
    for (let i = 0; i < 6; i++) await seed(a.id, '#cold', 5, 100);

    const result = await hotTopics();
    const hot = result.strongest.find((t) => t.tag === 'hot')!;
    expect(hot.usedByAccounts).toBe(2);
    expect(hot.performanceRatio).toBeGreaterThan(1);
    expect(result.strongest[0]!.tag).toBe('hot');
  });

  it('marks tags the managed account already uses', async () => {
    const rival = await upsertAccount({ handle: 'top7', role: 'competitor' });
    const self = await upsertAccount({ handle: 'mine7', role: 'self' });
    for (let i = 0; i < 3; i++) await seed(rival.id, '#shared', 5);
    await seed(self.id, '#shared', 2);

    const result = await hotTopics();
    expect(result.strongest.find((t) => t.tag === 'shared')!.usedByYou).toBe(true);
  });

  it("does not count the managed account's posts in the pool", async () => {
    const self = await upsertAccount({ handle: 'mine8', role: 'self' });
    for (let i = 0; i < 5; i++) await seed(self.id, '#mine', 5);

    const result = await hotTopics();
    expect(result.recentPostCount).toBe(0);
    expect(result.strongest).toHaveLength(0);
  });
});
