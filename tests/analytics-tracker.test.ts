import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, postInsights, posts } from '../lib/db/schema';
import { summariseTracker, trackedPosts } from '../lib/analytics/tracker';
import { upsertAccount } from '../lib/ingest/upsert';

afterEach(async () => {
  await db().delete(postInsights);
  await db().delete(posts);
  await db().delete(accounts);
});

afterAll(async () => {
  await closeDb();
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

async function seedPost(accountId: number, shortcode: string, takenAt: Date) {
  const [row] = await db()
    .insert(posts)
    .values({ accountId, shortcode, type: 'reel', takenAt, source: 'graph', raw: {} })
    .returning({ id: posts.id });
  return row!.id;
}

async function seedInsight(
  postId: number,
  checkpoint: 't24' | 't48' | 't7d' | 'latest',
  reach: number | null,
) {
  await db().insert(postInsights).values({ postId, checkpoint, reach });
}

describe('trackedPosts', () => {
  it('computes growth across fixed checkpoints and movement since the last one', async () => {
    const account = await upsertAccount({ handle: 't1', role: 'self' });
    const postId = await seedPost(account.id, 'GROW', hoursAgo(200));
    await seedInsight(postId, 't24', 1000);
    await seedInsight(postId, 't48', 1500);
    await seedInsight(postId, 't7d', 3000);
    await seedInsight(postId, 'latest', 3600);

    const [row] = await trackedPosts(account.id);
    expect(row!.points.t24!.reach).toBe(1000);
    expect(row!.reachGrowth).toBe(2000);
    expect(row!.sinceLastCheckpoint).toBe(600);
    expect(row!.status).toBe('climbing');
    expect(row!.awaiting).toBeNull();
  });

  it('calls a post settled when the movement since the last checkpoint is noise', async () => {
    const account = await upsertAccount({ handle: 't2', role: 'self' });
    const postId = await seedPost(account.id, 'FLAT', hoursAgo(200));
    await seedInsight(postId, 't24', 1000);
    await seedInsight(postId, 't48', 1000);
    await seedInsight(postId, 't7d', 1000);
    // +1% — reach ticks up on almost every post forever; that isn't climbing.
    await seedInsight(postId, 'latest', 1010);

    const [row] = await trackedPosts(account.id);
    expect(row!.status).toBe('settled');
  });

  it('says "too new" rather than "not measured" for a post under a day old', async () => {
    const account = await upsertAccount({ handle: 't3', role: 'self' });
    await seedPost(account.id, 'FRESH', hoursAgo(3));

    const [row] = await trackedPosts(account.id);
    expect(row!.status).toBe('too new');
    expect(row!.awaiting).toBe('t24');
    expect(row!.reachGrowth).toBeNull();
  });

  it('names the checkpoint a post is waiting on when a capture was missed', async () => {
    const account = await upsertAccount({ handle: 't4', role: 'self' });
    const postId = await seedPost(account.id, 'MISSED', hoursAgo(60));
    // Old enough for t24 and t48, but only t24 was captured.
    await seedInsight(postId, 't24', 500);
    await seedInsight(postId, 'latest', 800);

    const [row] = await trackedPosts(account.id);
    expect(row!.awaiting).toBe('t48');
    // One checkpoint is not a trajectory.
    expect(row!.reachGrowth).toBeNull();
    expect(row!.sinceLastCheckpoint).toBe(300);
  });

  it('leaves everything blank, not zero, for an old post with no insights', async () => {
    const account = await upsertAccount({ handle: 't5', role: 'self' });
    await seedPost(account.id, 'OLD', hoursAgo(1000));

    const [row] = await trackedPosts(account.id);
    expect(row!.status).toBe('not measured');
    expect(row!.points.latest).toBeNull();
    expect(row!.reachGrowth).toBeNull();
    expect(row!.sinceLastCheckpoint).toBeNull();
  });

  it('ignores checkpoints whose reach the API never returned', async () => {
    const account = await upsertAccount({ handle: 't6', role: 'self' });
    const postId = await seedPost(account.id, 'PARTIAL', hoursAgo(200));
    await seedInsight(postId, 't24', null);
    await seedInsight(postId, 't7d', 2000);
    await seedInsight(postId, 'latest', 2100);

    const [row] = await trackedPosts(account.id);
    // Only one usable fixed point, so there is no growth figure to give.
    expect(row!.reachGrowth).toBeNull();
    expect(row!.sinceLastCheckpoint).toBe(100);
  });
});

describe('summariseTracker', () => {
  it('counts each status once', async () => {
    const account = await upsertAccount({ handle: 't7', role: 'self' });
    const climbing = await seedPost(account.id, 'C', hoursAgo(200));
    await seedInsight(climbing, 't7d', 1000);
    await seedInsight(climbing, 'latest', 2000);
    await seedPost(account.id, 'N', hoursAgo(2));

    const summary = summariseTracker(await trackedPosts(account.id));
    expect(summary.climbing).toBe(1);
    expect(summary.tooNew).toBe(1);
  });
});
