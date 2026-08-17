import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import testFixture from '../fixtures/testaccount.json';
import { closeDb, db } from '../lib/db/client';
import { accounts, jobs, posts } from '../lib/db/schema';
import { __setEnvForTests, env } from '../lib/env';
import { upsertAccount } from '../lib/ingest/upsert';
import { enqueue, getJob, markWaiting, claimNext } from '../lib/jobs/queue';

vi.mock('../lib/providers', async () => {
  const actual = await vi.importActual<typeof import('../lib/providers')>('../lib/providers');
  return {
    ...actual,
    getScraper: () => ({
      id: 'apify',
      kind: 'scraper',
      costsMoney: false,
      costNote: 'mocked',
      async health() {
        return { ok: true, detail: 'mocked' };
      },
      async fetchRun() {
        return { status: 'SUCCEEDED', succeeded: true, items: testFixture };
      },
    }),
  };
});

const { POST } = await import('../app/api/webhooks/apify/route');

afterEach(async () => {
  await db().delete(jobs);
  await db().delete(posts);
  await db().delete(accounts);
  __setEnvForTests(null);
});

afterAll(async () => {
  await closeDb();
});

async function seedWaitingJob(runId: string) {
  const account = await upsertAccount({ handle: 'testaccount', role: 'self' });
  const jobId = await enqueue('scan_account', { accountId: account.id, limit: 100 });
  await claimNext(); // simulate the runner having already claimed+run the "start" half
  await markWaiting(jobId!, { runId, limit: 100, stopAt: [] });
  return { account, jobId: jobId! };
}

describe('POST /api/webhooks/apify (the fire → webhook → complete half of the scan pipeline)', () => {
  it('finishes a waiting scan job and ingests the completed run', async () => {
    const { account, jobId } = await seedWaitingJob('run-abc');

    const response = await POST(
      new Request('http://localhost/api/webhooks/apify', {
        method: 'POST',
        body: JSON.stringify({
          eventType: 'ACTOR.RUN.SUCCEEDED',
          resource: { id: 'run-abc', status: 'SUCCEEDED' },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.postsIngested).toBe(6);

    const job = await getJob(jobId);
    expect(job?.status).toBe('done');

    const stored = await db().select().from(posts).where(eq(posts.accountId, account.id));
    expect(stored).toHaveLength(6);
  });

  it('acknowledges but ignores a run id with no matching waiting job', async () => {
    const response = await POST(
      new Request('http://localhost/api/webhooks/apify', {
        method: 'POST',
        body: JSON.stringify({ resource: { id: 'unknown-run' } }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.note).toMatch(/no matching/);
  });

  it('rejects a malformed body', async () => {
    const response = await POST(
      new Request('http://localhost/api/webhooks/apify', { method: 'POST', body: 'not json' }),
    );
    expect(response.status).toBe(400);
  });

  it('enforces the webhook secret when one is configured', async () => {
    __setEnvForTests({ ...env(), APIFY_WEBHOOK_SECRET: 'shh' });
    await seedWaitingJob('run-secret');

    const wrongSecret = await POST(
      new Request('http://localhost/api/webhooks/apify?secret=wrong', {
        method: 'POST',
        body: JSON.stringify({ resource: { id: 'run-secret' } }),
      }),
    );
    expect(wrongSecret.status).toBe(401);

    const rightSecret = await POST(
      new Request('http://localhost/api/webhooks/apify?secret=shh', {
        method: 'POST',
        body: JSON.stringify({ resource: { id: 'run-secret' } }),
      }),
    );
    expect(rightSecret.status).toBe(200);
  });
});
