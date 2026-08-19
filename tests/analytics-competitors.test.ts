import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, posts } from '../lib/db/schema';
import { competitorStats } from '../lib/analytics/competitors';
import { removeAccount, upsertAccount } from '../lib/ingest/upsert';
import { eq } from 'drizzle-orm';

afterEach(async () => {
  await db().delete(posts);
  await db().delete(accounts);
});

afterAll(async () => {
  await closeDb();
});

let n = 0;
async function seed(accountId: number, likes: number, takenAt = new Date()) {
  await db()
    .insert(posts)
    .values({
      accountId,
      shortcode: `K${++n}`,
      type: 'image',
      likes,
      comments: 0,
      takenAt,
      raw: {},
    });
}

describe('competitorStats', () => {
  it('ranks by median engagement and reports how many posts back it', async () => {
    const strong = await upsertAccount({ handle: 'strong', role: 'competitor' });
    const weak = await upsertAccount({ handle: 'weak', role: 'competitor' });
    for (let i = 0; i < 3; i++) await seed(strong.id, 500);
    for (let i = 0; i < 3; i++) await seed(weak.id, 50);

    const stats = await competitorStats();
    expect(stats[0]!.account.handle).toBe('strong');
    expect(stats[0]!.medianEngagement).toBe(500);
    expect(stats[0]!.postsHeld).toBe(3);
  });

  it('leaves median engagement null for a competitor with no posts held', async () => {
    await upsertAccount({ handle: 'empty', role: 'competitor' });
    const [row] = await competitorStats();
    expect(row!.postsHeld).toBe(0);
    expect(row!.medianEngagement).toBeNull();
    expect(row!.newestPost).toBeNull();
  });

  it('flags an account past its rescan cooldown', async () => {
    const stale = await upsertAccount({ handle: 'stale', role: 'competitor' });
    const fresh = await upsertAccount({ handle: 'fresh', role: 'competitor' });
    await db()
      .update(accounts)
      .set({ lastScrapedAt: new Date(Date.now() - 30 * 86_400_000) })
      .where(eq(accounts.id, stale.id));
    await db().update(accounts).set({ lastScrapedAt: new Date() }).where(eq(accounts.id, fresh.id));

    const stats = await competitorStats(7);
    expect(stats.find((s) => s.account.handle === 'stale')!.dueForRescan).toBe(true);
    expect(stats.find((s) => s.account.handle === 'fresh')!.dueForRescan).toBe(false);
  });

  it('treats a never-scanned account as due', async () => {
    await upsertAccount({ handle: 'never', role: 'competitor' });
    const [row] = await competitorStats(7);
    expect(row!.dueForRescan).toBe(true);
  });

  it('does not include the managed account', async () => {
    const self = await upsertAccount({ handle: 'mine', role: 'self' });
    await seed(self.id, 1000);
    expect(await competitorStats()).toHaveLength(0);
  });

  it('reports the newest post held, not the newest scan', async () => {
    const account = await upsertAccount({ handle: 'dates', role: 'competitor' });
    await seed(account.id, 10, new Date('2026-01-01T00:00:00Z'));
    await seed(account.id, 10, new Date('2026-06-01T00:00:00Z'));

    const [row] = await competitorStats();
    expect(row!.newestPost!.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('removeAccount', () => {
  it('removes a competitor and cascades their posts', async () => {
    const account = await upsertAccount({ handle: 'goner', role: 'competitor' });
    await seed(account.id, 10);

    await removeAccount(account.id);
    expect(await competitorStats()).toHaveLength(0);
    expect(await db().select().from(posts)).toHaveLength(0);
  });

  it('refuses to remove the managed account', async () => {
    const self = await upsertAccount({ handle: 'protected', role: 'self' });
    await removeAccount(self.id);
    const remaining = await db().select().from(accounts).where(eq(accounts.id, self.id));
    expect(remaining).toHaveLength(1);
  });
});
