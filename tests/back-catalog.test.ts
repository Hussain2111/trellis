import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, hookLabels, postFeatures, posts, resurfacedPosts } from '../lib/db/schema';
import { mineBackCatalog, persistBackCatalog } from '../lib/analysis/back-catalog';
import { upsertAccount, upsertPosts } from '../lib/ingest/upsert';
import type { ScrapedPost } from '../lib/providers/scraper/types';

afterEach(async () => {
  await db().delete(resurfacedPosts);
  await db().delete(hookLabels);
  await db().delete(postFeatures);
  await db().delete(posts);
  await db().delete(accounts);
});

afterAll(async () => {
  await closeDb();
});

const daysAgo = (n: number): number => Math.floor(Date.now() / 1000) - n * 86_400;

let n = 0;
const scraped = (overrides: Partial<ScrapedPost> = {}): ScrapedPost => ({
  shortcode: `BC${n++}`,
  type: 'reel',
  caption: 'x',
  takenAt: daysAgo(60),
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

describe('mineBackCatalog', () => {
  it("surfaces a category whose best post is old and hasn't been repeated recently", async () => {
    const account = await upsertAccount({ handle: 'creator', role: 'self' });
    await upsertPosts(account.id, [
      scraped({ shortcode: 'peak', likes: 552_000, takenAt: daysAgo(60) }),
    ]);

    const [row] = await db().select().from(posts).where(eq(posts.accountId, account.id));
    await db().insert(postFeatures).values({ postId: row!.id, isOutlier: true });
    await db()
      .insert(hookLabels)
      .values({ postId: row!.id, category: 'personal_story', generatedBy: 'test' });

    const entries = await mineBackCatalog(account.id, 30);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.postId).toBe(row!.id);
    expect(entries[0]?.peakValue).toBe(552_000);
    expect(entries[0]?.daysSinceRepeated).toBeGreaterThanOrEqual(60);
  });

  it('does not surface a category that was posted again recently', async () => {
    const account = await upsertAccount({ handle: 'creator2', role: 'self' });
    await upsertPosts(account.id, [
      scraped({ shortcode: 'peak2', likes: 552_000, takenAt: daysAgo(60) }),
      scraped({ shortcode: 'recent', likes: 400, takenAt: daysAgo(2) }),
    ]);
    const rows = await db().select().from(posts).where(eq(posts.accountId, account.id));
    for (const row of rows) {
      await db()
        .insert(postFeatures)
        .values({ postId: row.id, isOutlier: row.shortcode === 'peak2' });
      await db()
        .insert(hookLabels)
        .values({ postId: row.id, category: 'personal_story', generatedBy: 'test' });
    }

    expect(await mineBackCatalog(account.id, 30)).toHaveLength(0);
  });

  it('ignores categories with no outlier post at all', async () => {
    const account = await upsertAccount({ handle: 'creator3', role: 'self' });
    await upsertPosts(account.id, [
      scraped({ shortcode: 'meh', likes: 100, takenAt: daysAgo(60) }),
    ]);
    const [row] = await db().select().from(posts).where(eq(posts.accountId, account.id));
    await db().insert(postFeatures).values({ postId: row!.id, isOutlier: false });
    await db()
      .insert(hookLabels)
      .values({ postId: row!.id, category: 'other', generatedBy: 'test' });

    expect(await mineBackCatalog(account.id, 30)).toHaveLength(0);
  });
});

describe('persistBackCatalog', () => {
  it('is idempotent — re-running clears the prior set rather than accumulating', async () => {
    const account = await upsertAccount({ handle: 'creator4', role: 'self' });
    await upsertPosts(account.id, [scraped({ shortcode: 'p1', likes: 1000 })]);
    const [row] = await db().select().from(posts).where(eq(posts.accountId, account.id));

    await persistBackCatalog(account.id, [
      { postId: row!.id, metric: 'likes', peakValue: 1000, daysSinceRepeated: 40 },
    ]);
    await persistBackCatalog(account.id, [
      { postId: row!.id, metric: 'likes', peakValue: 1000, daysSinceRepeated: 41 },
    ]);

    const stored = await db()
      .select()
      .from(resurfacedPosts)
      .where(eq(resurfacedPosts.postId, row!.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.daysSinceRepeated).toBe(41);
  });
});
