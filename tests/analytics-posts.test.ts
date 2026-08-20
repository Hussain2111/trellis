import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, postInsights, posts } from '../lib/db/schema';
import {
  byFormat,
  insightCoverage,
  median,
  postAnalytics,
  summarise,
} from '../lib/analytics/posts';
import { upsertAccount } from '../lib/ingest/upsert';

afterEach(async () => {
  await db().delete(postInsights);
  await db().delete(posts);
  await db().delete(accounts);
});

afterAll(async () => {
  await closeDb();
});

async function seed(
  accountId: number,
  post: { shortcode: string; type?: 'image' | 'reel'; likes?: number; comments?: number },
  insight?: { reach?: number | null; saves?: number | null; totalInteractions?: number | null },
) {
  const [row] = await db()
    .insert(posts)
    .values({
      accountId,
      shortcode: post.shortcode,
      type: post.type ?? 'image',
      likes: post.likes ?? null,
      comments: post.comments ?? null,
      takenAt: new Date(),
      source: 'graph',
      raw: {},
    })
    .returning({ id: posts.id });

  if (insight) {
    await db()
      .insert(postInsights)
      .values({
        postId: row!.id,
        checkpoint: 'latest',
        reach: insight.reach ?? null,
        saves: insight.saves ?? null,
        totalInteractions: insight.totalInteractions ?? null,
      });
  }
  return row!.id;
}

describe('postAnalytics', () => {
  it('leaves reach blank for posts with no insights rather than zeroing them', async () => {
    const account = await upsertAccount({ handle: 'a1', role: 'self' });
    await seed(account.id, { shortcode: 'MEASURED', likes: 10, comments: 2 }, { reach: 1000 });
    await seed(account.id, { shortcode: 'UNMEASURED', likes: 5, comments: 1 });

    const rows = await postAnalytics(account.id, 500);
    const measured = rows.find((r) => r.post.shortcode === 'MEASURED')!;
    const unmeasured = rows.find((r) => r.post.shortcode === 'UNMEASURED')!;

    expect(measured.reach).toBe(1000);
    expect(unmeasured.reach).toBeNull();
    // The interactions are known even when reach is not — that half is real.
    expect(unmeasured.totalInteractions).toBe(6);
    expect(unmeasured.engagementOnReach).toBeNull();
    expect(unmeasured.engagementOnFollowers).toBeCloseTo(6 / 500);
  });

  it("prefers Meta's own total_interactions over adding likes and comments", async () => {
    const account = await upsertAccount({ handle: 'a2', role: 'self' });
    await seed(
      account.id,
      { shortcode: 'T', likes: 10, comments: 2 },
      { reach: 100, totalInteractions: 40 },
    );

    const [row] = await postAnalytics(account.id, 500);
    expect(row!.totalInteractions).toBe(40);
    expect(row!.engagementOnReach).toBeCloseTo(0.4);
  });

  it('never divides by a zero reach', async () => {
    const account = await upsertAccount({ handle: 'a3', role: 'self' });
    await seed(account.id, { shortcode: 'Z', likes: 3 }, { reach: 0 });
    const [row] = await postAnalytics(account.id, 100);
    expect(row!.engagementOnReach).toBeNull();
  });

  it('has no follower-based rate when the follower count is unknown', async () => {
    const account = await upsertAccount({ handle: 'a4', role: 'self' });
    await seed(account.id, { shortcode: 'F', likes: 3 });
    const [row] = await postAnalytics(account.id, null);
    expect(row!.engagementOnFollowers).toBeNull();
  });
});

describe('summarise', () => {
  it('counts measured and unmeasured separately and medians only the known values', async () => {
    const account = await upsertAccount({ handle: 'a5', role: 'self' });
    await seed(account.id, { shortcode: 'S1' }, { reach: 100, saves: 5 });
    await seed(account.id, { shortcode: 'S2' }, { reach: 300, saves: 1 });
    await seed(account.id, { shortcode: 'S3' });

    const summary = summarise(await postAnalytics(account.id, 1000));
    expect(summary.measured).toBe(2);
    expect(summary.unmeasured).toBe(1);
    expect(summary.medianReach).toBe(200);
    expect(summary.totalSaves).toBe(6);
    // No shares were ever reported — that is null, not 0.
    expect(summary.totalShares).toBeNull();
  });
});

describe('byFormat', () => {
  it('groups by media type and medians within each group', async () => {
    const account = await upsertAccount({ handle: 'a6', role: 'self' });
    await seed(account.id, { shortcode: 'R1', type: 'reel' }, { reach: 1000 });
    await seed(account.id, { shortcode: 'R2', type: 'reel' }, { reach: 3000 });
    await seed(account.id, { shortcode: 'I1', type: 'image' }, { reach: 100 });

    const formats = byFormat(await postAnalytics(account.id, 1000));
    expect(formats[0]!.type).toBe('reel');
    expect(formats[0]!.count).toBe(2);
    expect(formats[0]!.medianReach).toBe(2000);
    expect(formats.find((f) => f.type === 'image')!.medianReach).toBe(100);
  });
});

describe('median', () => {
  it('averages the middle pair for an even count and returns null for none', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('insightCoverage', () => {
  it('reports how many posts carry insights at all', async () => {
    const account = await upsertAccount({ handle: 'a7', role: 'self' });
    await seed(account.id, { shortcode: 'C1' }, { reach: 1 });
    await seed(account.id, { shortcode: 'C2' });
    expect(await insightCoverage(account.id)).toEqual({ total: 2, measured: 1 });
  });
});
