import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, jobs, posts } from '../lib/db/schema';
import { upsertAccount } from '../lib/ingest/upsert';
import { registerJobHandlers } from '../lib/jobs/handlers';
import { enqueue, getJob } from '../lib/jobs/queue';
import { runTick } from '../lib/jobs/runner';

registerJobHandlers();

afterEach(async () => {
  await db().delete(jobs);
  await db().delete(posts);
  await db().delete(accounts);
});

afterAll(async () => {
  await closeDb();
});

/**
 * Fixture mode is synchronous (no real webhook round trip), so this exercises
 * the "fire → complete" half of the pipeline end to end: enqueue, one tick,
 * done, posts stored, features job chained. See tests/webhook-apify.test.ts
 * for the live-mode "fire → webhook → complete" half.
 */
describe('scan pipeline (fixture mode)', () => {
  it('scans the fixture account, stores posts, and chains compute_features', async () => {
    const account = await upsertAccount({ handle: 'testaccount', role: 'competitor' });
    const jobId = await enqueue('scan_account', { accountId: account.id, limit: 100 });

    const result = await runTick(['scan_account'], 5_000);
    expect(result.processed).toBe(1);

    const job = await getJob(jobId!);
    expect(job?.status).toBe('done');

    const storedPosts = await db().select().from(posts).where(eq(posts.accountId, account.id));
    expect(storedPosts).toHaveLength(6);

    const [refreshedAccount] = await db()
      .select()
      .from(accounts)
      .where(eq(accounts.id, account.id));
    expect(refreshedAccount?.lastScrapedAt).toBeInstanceOf(Date);

    const chained = await db().select().from(jobs).where(eq(jobs.type, 'compute_features'));
    expect(chained).toHaveLength(1);
    expect(chained[0]?.payload).toEqual({ accountId: account.id });

    // Discovery no longer chains off a scan — it is the expensive Apify path
    // and belongs on the weekly cron.
    const discovery = await db().select().from(jobs).where(eq(jobs.type, 'discover_competitors'));
    expect(discovery).toHaveLength(0);
  });

  it('refuses to Apify-scan the managed account — its data comes from the Graph API', async () => {
    const account = await upsertAccount({ handle: 'mineaccount', role: 'self' });
    const jobId = await enqueue('scan_account', { accountId: account.id, limit: 100 });
    await runTick(['scan_account'], 5_000);

    const job = await getJob(jobId!);
    expect(job?.status).toBe('failed');
    expect(job?.lastError).toMatch(/Graph API/);
    expect(await db().select().from(posts)).toHaveLength(0);
  });

  it('is idempotent: scanning twice does not duplicate posts', async () => {
    const account = await upsertAccount({ handle: 'testaccount', role: 'competitor' });
    await enqueue('scan_account', { accountId: account.id, limit: 100 });
    await runTick(['scan_account'], 5_000);

    await enqueue('scan_account', { accountId: account.id, limit: 100 });
    await runTick(['scan_account'], 5_000);

    const storedPosts = await db().select().from(posts).where(eq(posts.accountId, account.id));
    expect(storedPosts).toHaveLength(6);
  });

  it('fails permanently when the account no longer exists', async () => {
    const jobId = await enqueue('scan_account', { accountId: 999_999, limit: 100 });
    await runTick(['scan_account'], 5_000);
    const job = await getJob(jobId!);
    expect(job?.status).toBe('failed');
    expect(job?.lastError).toMatch(/no longer exists/);
  });
});
