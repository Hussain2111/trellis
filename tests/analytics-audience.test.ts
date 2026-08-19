import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, postComments, posts } from '../lib/db/schema';
import { audienceSummary, mostActiveFollowers, repeatBreakdown } from '../lib/analytics/audience';
import { upsertAccount } from '../lib/ingest/upsert';

afterEach(async () => {
  await db().delete(postComments);
  await db().delete(posts);
  await db().delete(accounts);
});

afterAll(async () => {
  await closeDb();
});

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

async function seedPost(accountId: number, shortcode: string) {
  const [row] = await db()
    .insert(posts)
    .values({ accountId, shortcode, type: 'image', source: 'graph', raw: {} })
    .returning({ id: posts.id });
  return row!.id;
}

let commentId = 0;
async function comment(postId: number, username: string | null, commentedAt: Date | null) {
  await db()
    .insert(postComments)
    .values({ postId, igCommentId: `c${++commentId}`, username, commentedAt });
}

describe('mostActiveFollowers', () => {
  it('ranks by comment count and counts distinct posts per person', async () => {
    const account = await upsertAccount({ handle: 'aud1', role: 'self' });
    const p1 = await seedPost(account.id, 'P1');
    const p2 = await seedPost(account.id, 'P2');

    await comment(p1, 'loud', daysAgo(1));
    await comment(p1, 'loud', daysAgo(2));
    await comment(p2, 'loud', daysAgo(3));
    await comment(p1, 'quiet', daysAgo(1));

    const rows = await mostActiveFollowers(account.id);
    expect(rows[0]!.username).toBe('loud');
    expect(rows[0]!.comments).toBe(3);
    expect(rows[0]!.postsCommentedOn).toBe(2);
    expect(rows[1]!.username).toBe('quiet');
  });

  it('excludes comments outside the window', async () => {
    const account = await upsertAccount({ handle: 'aud2', role: 'self' });
    const post = await seedPost(account.id, 'P');
    await comment(post, 'recent', daysAgo(10));
    await comment(post, 'ancient', daysAgo(200));

    const rows = await mostActiveFollowers(account.id, { windowDays: 90 });
    expect(rows.map((r) => r.username)).toEqual(['recent']);
  });

  it('leaves undated comments out rather than assuming they are recent', async () => {
    const account = await upsertAccount({ handle: 'aud3', role: 'self' });
    const post = await seedPost(account.id, 'P');
    await comment(post, 'dated', daysAgo(1));
    await comment(post, 'undated', null);

    const rows = await mostActiveFollowers(account.id);
    expect(rows.map((r) => r.username)).toEqual(['dated']);

    // But they are still counted and reported, not silently dropped.
    const summary = await audienceSummary(account.id);
    expect(summary.undated).toBe(1);
  });

  it("does not count another account's comments", async () => {
    const mine = await upsertAccount({ handle: 'aud4', role: 'self' });
    const theirs = await upsertAccount({ handle: 'rival', role: 'competitor' });
    await comment(await seedPost(mine.id, 'MINE'), 'fan', daysAgo(1));
    await comment(await seedPost(theirs.id, 'THEIRS'), 'other', daysAgo(1));

    const rows = await mostActiveFollowers(mine.id);
    expect(rows.map((r) => r.username)).toEqual(['fan']);
  });
});

describe('audienceSummary', () => {
  it('counts comments, people and posts within the window', async () => {
    const account = await upsertAccount({ handle: 'aud5', role: 'self' });
    const p1 = await seedPost(account.id, 'S1');
    const p2 = await seedPost(account.id, 'S2');
    await comment(p1, 'a', daysAgo(1));
    await comment(p1, 'b', daysAgo(2));
    await comment(p2, 'a', daysAgo(3));

    const summary = await audienceSummary(account.id);
    expect(summary.totalComments).toBe(3);
    expect(summary.uniqueCommenters).toBe(2);
    expect(summary.postsWithComments).toBe(2);
  });
});

describe('repeatBreakdown', () => {
  it('buckets one-off, occasional and regular commenters', () => {
    const rows = [
      { username: 'a', comments: 1, postsCommentedOn: 1, firstSeen: null, lastSeen: null },
      { username: 'b', comments: 3, postsCommentedOn: 2, firstSeen: null, lastSeen: null },
      { username: 'c', comments: 9, postsCommentedOn: 5, firstSeen: null, lastSeen: null },
    ];
    expect(repeatBreakdown(rows)).toEqual({ oneOff: 1, occasional: 1, regular: 1 });
  });
});
