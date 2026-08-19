import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, hookLabels, posts } from '../lib/db/schema';
import {
  hooksAmongIdeas,
  ideas,
  MIN_POSTS_FOR_BASELINE,
  ownBreakouts,
} from '../lib/analytics/ideas';
import { upsertAccount } from '../lib/ingest/upsert';

afterEach(async () => {
  await db().delete(hookLabels);
  await db().delete(posts);
  await db().delete(accounts);
});

afterAll(async () => {
  await closeDb();
});

let n = 0;
async function seed(
  accountId: number,
  likes: number,
  options: { daysAgo?: number; hook?: string } = {},
) {
  const [row] = await db()
    .insert(posts)
    .values({
      accountId,
      shortcode: `S${++n}`,
      type: 'reel',
      likes,
      comments: 0,
      takenAt: new Date(Date.now() - (options.daysAgo ?? 1) * 86_400_000),
      raw: {},
    })
    .returning({ id: posts.id });
  if (options.hook) {
    await db()
      .insert(hookLabels)
      .values({ postId: row!.id, category: options.hook, generatedBy: 'test' });
  }
  return row!.id;
}

/** Five ordinary posts, so the account has a baseline at all. */
async function seedBaseline(accountId: number, value: number) {
  for (let i = 0; i < MIN_POSTS_FOR_BASELINE; i++) await seed(accountId, value, { daysAgo: 30 });
}

describe('ideas', () => {
  it('scores a post against its own account, so a small account can outrank a big one', async () => {
    const small = await upsertAccount({ handle: 'small', role: 'competitor' });
    const big = await upsertAccount({ handle: 'big', role: 'competitor' });
    await seedBaseline(small.id, 100);
    await seedBaseline(big.id, 10_000);

    // 10x its own normal, but far fewer raw likes than the big account's post.
    await seed(small.id, 1000);
    // 2x its own normal, and vastly more raw likes.
    await seed(big.id, 20_000);

    const { ideas: list } = await ideas();
    expect(list[0]!.handle).toBe('small');
    expect(list[0]!.viralScore).toBeCloseTo(10);
    expect(list[1]!.handle).toBe('big');
    expect(list[1]!.viralScore).toBeCloseTo(2);
  });

  it('reports the baseline it divided by, so the score is checkable', async () => {
    const account = await upsertAccount({ handle: 'c1', role: 'competitor' });
    await seedBaseline(account.id, 200);
    await seed(account.id, 800);

    const { ideas: list } = await ideas();
    expect(list[0]!.baseline).toBe(200);
    expect(list[0]!.engagement).toBe(800);
    expect(list[0]!.viralScore).toBeCloseTo(4);
  });

  it('excludes accounts with too little history to have a meaningful median', async () => {
    const thin = await upsertAccount({ handle: 'thin', role: 'competitor' });
    await seed(thin.id, 10);
    await seed(thin.id, 10_000);

    const { ideas: list, skippedAccounts } = await ideas();
    expect(list).toHaveLength(0);
    expect(skippedAccounts).toEqual([{ handle: 'thin', posts: 2 }]);
  });

  it('excludes an account whose median engagement is zero rather than dividing by it', async () => {
    const silent = await upsertAccount({ handle: 'silent', role: 'competitor' });
    await seedBaseline(silent.id, 0);
    await seed(silent.id, 500);

    const { ideas: list, skippedAccounts } = await ideas();
    expect(list).toHaveLength(0);
    expect(skippedAccounts.map((a) => a.handle)).toContain('silent');
  });

  it('computes the baseline over all held history, not just the scored window', async () => {
    const account = await upsertAccount({ handle: 'c2', role: 'competitor' });
    // Baseline posts are all outside the 60-day window.
    for (let i = 0; i < MIN_POSTS_FOR_BASELINE; i++) await seed(account.id, 100, { daysAgo: 300 });
    await seed(account.id, 500, { daysAgo: 5 });

    const { ideas: list } = await ideas({ windowDays: 60 });
    // The old posts don't appear as ideas, but they still set the denominator.
    expect(list).toHaveLength(1);
    expect(list[0]!.baseline).toBe(100);
    expect(list[0]!.viralScore).toBeCloseTo(5);
  });

  it("leaves out posts that merely matched their account's normal", async () => {
    const account = await upsertAccount({ handle: 'c3', role: 'competitor' });
    await seedBaseline(account.id, 100);
    await seed(account.id, 110);

    const { ideas: list } = await ideas({ minScore: 1.5 });
    expect(list).toHaveLength(0);
  });

  it('never scores the managed account as a competitor idea', async () => {
    const self = await upsertAccount({ handle: 'mine', role: 'self' });
    await seedBaseline(self.id, 100);
    await seed(self.id, 5000);

    const { ideas: list } = await ideas();
    expect(list).toHaveLength(0);
  });
});

describe('hooksAmongIdeas', () => {
  it('counts hook categories across the breakouts, ignoring unlabelled ones', async () => {
    const account = await upsertAccount({ handle: 'c4', role: 'competitor' });
    await seedBaseline(account.id, 100);
    await seed(account.id, 500, { hook: 'bold_claim' });
    await seed(account.id, 600, { hook: 'bold_claim' });
    await seed(account.id, 700);

    const { ideas: list } = await ideas();
    expect(hooksAmongIdeas(list)).toEqual([{ category: 'bold_claim', count: 2 }]);
  });
});

describe('ownBreakouts', () => {
  it('scores the managed account against its own median', async () => {
    const self = await upsertAccount({ handle: 'mine2', role: 'self' });
    await seedBaseline(self.id, 50);
    await seed(self.id, 400);

    const rows = await ownBreakouts(self.id);
    expect(rows[0]!.viralScore).toBeCloseTo(8);
    expect(rows[0]!.baseline).toBe(50);
  });

  it('returns nothing when there is not enough history for a baseline', async () => {
    const self = await upsertAccount({ handle: 'mine3', role: 'self' });
    await seed(self.id, 1000);
    expect(await ownBreakouts(self.id)).toEqual([]);
  });
});
