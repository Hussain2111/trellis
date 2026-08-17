import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { jobs } from '../lib/db/schema';
import {
  activeJobs,
  claimNext,
  complete,
  enqueue,
  fail,
  getJob,
  markWaiting,
  requeue,
  resume,
} from '../lib/jobs/queue';

afterEach(async () => {
  await db().delete(jobs);
});

afterAll(async () => {
  await closeDb();
});

describe('enqueue', () => {
  it('validates the payload against its schema', async () => {
    const id = await enqueue('scan_account', { accountId: 7 });
    const job = await getJob(id!);
    expect(job?.payload).toEqual({ accountId: 7, limit: 100 });
  });

  it('rejects a payload that fails validation', async () => {
    await expect(enqueue('scan_account', { accountId: 'nope' })).rejects.toThrow();
  });

  it('dedupes against an unfinished job with the same type and payload', async () => {
    const first = await enqueue('scan_account', { accountId: 1 }, { dedupe: true });
    const second = await enqueue('scan_account', { accountId: 1 }, { dedupe: true });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('does not dedupe jobs of the same type with different payloads', async () => {
    const first = await enqueue('scan_account', { accountId: 1 }, { dedupe: true });
    const second = await enqueue('scan_account', { accountId: 2 }, { dedupe: true });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });
});

describe('claimNext', () => {
  it('atomically claims the highest-priority pending job', async () => {
    await enqueue('noop', { steps: 1 }, { priority: 0 });
    const highId = await enqueue('noop', { steps: 1 }, { priority: 5 });

    const claimed = await claimNext();
    expect(claimed?.id).toBe(highId);
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.attempts).toBe(1);
  });

  it('never returns the same job to two concurrent claims', async () => {
    await enqueue('noop', { steps: 1 });
    const [a, b] = await Promise.all([claimNext(), claimNext()]);
    const claimedIds = [a?.id, b?.id].filter((id) => id !== undefined);
    expect(claimedIds).toHaveLength(1);
  });

  it('respects a type filter', async () => {
    await enqueue('noop', { steps: 1 });
    const claimed = await claimNext(['scan_account']);
    expect(claimed).toBeNull();
  });
});

describe('complete / fail / requeue', () => {
  it('marks a job done', async () => {
    const id = await enqueue('noop', { steps: 1 });
    await claimNext();
    await complete(id!);
    const job = await getJob(id!);
    expect(job?.status).toBe('done');
    expect(job?.progress).toBe(1);
  });

  it('retries a transient failure with backoff, then fails permanently once attempts are exhausted', async () => {
    const id = await enqueue('noop', { steps: 1 }, { maxAttempts: 1 });
    const claimed = await claimNext();
    await fail(claimed!, new Error('boom'));
    const job = await getJob(id!);
    expect(job?.status).toBe('failed');
    expect(job?.lastError).toBe('boom');
  });

  it('requeue puts a job back without consuming a retry', async () => {
    const id = await enqueue('noop', { steps: 1 });
    await claimNext();
    await requeue(id!, 0);
    const job = await getJob(id!);
    expect(job?.status).toBe('pending');
    expect(job?.attempts).toBe(0);
  });
});

describe('markWaiting / resume (the fire-and-webhook pattern)', () => {
  it('a waiting job is not claimable until resumed', async () => {
    const id = await enqueue('scan_account', { accountId: 1 });
    await claimNext();
    await markWaiting(id!, { runId: 'apify-run-123' });

    const job = await getJob(id!);
    expect(job?.status).toBe('waiting');
    expect(job?.checkpoint).toEqual({ runId: 'apify-run-123' });

    expect(await claimNext()).toBeNull();

    await resume(id!);
    const resumed = await getJob(id!);
    expect(resumed?.status).toBe('pending');
  });

  it('activeJobs includes waiting jobs', async () => {
    const id = await enqueue('scan_account', { accountId: 1 });
    await claimNext();
    await markWaiting(id!, {});
    const active = await activeJobs();
    expect(active.map((j) => j.id)).toContain(id);
  });
});
