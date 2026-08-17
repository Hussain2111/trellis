import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropTempDb, useTempDb } from './helpers';
import {
  backoffSeconds,
  claimNext,
  complete,
  enqueue,
  fail,
  getJob,
  reapStaleClaims,
  saveProgress,
} from '@/lib/jobs/queue';
import { JobRunner } from '@/lib/jobs/runner';
import { register } from '@/lib/jobs/registry';
import { db } from '@/lib/db/client';
import { jobs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

beforeAll(() => useTempDb());
afterAll(() => dropTempDb());

describe('job queue', () => {
  it('validates payloads at enqueue time', () => {
    expect(() => enqueue('noop', { steps: -1 })).toThrow();
  });

  it('claims a job exactly once', () => {
    const id = enqueue('noop', { steps: 1, sleepMs: 0 });
    expect(id).toBeTypeOf('number');

    const first = claimNext();
    expect(first?.id).toBe(id);
    expect(first?.status).toBe('claimed');
    expect(first?.attempts).toBe(1);

    // Nothing else runnable — the same row cannot be claimed twice.
    expect(claimNext()).toBeNull();
    complete(first!.id);
  });

  it('honours priority then insertion order', () => {
    const low = enqueue('noop', {}, { priority: 0 });
    const high = enqueue('noop', {}, { priority: 10 });
    expect(claimNext()?.id).toBe(high);
    expect(claimNext()?.id).toBe(low);
    complete(high!);
    complete(low!);
  });

  it('dedupes when asked', () => {
    const first = enqueue('noop', {}, { dedupe: true });
    const second = enqueue('noop', {}, { dedupe: true });
    expect(first).toBeTypeOf('number');
    expect(second).toBeNull();
    complete(first!);
  });

  it('retries with backoff, then fails permanently', () => {
    const id = enqueue('noop', {}, { maxAttempts: 2 })!;
    const first = claimNext()!;
    fail(first, new Error('boom'));
    expect(getJob(id)?.status).toBe('pending');
    expect(getJob(id)?.lastError).toBe('boom');

    // Backoff pushed it into the future, so it is not immediately runnable.
    expect(claimNext()).toBeNull();
    db().update(jobs).set({ runAfter: 0 }).where(eq(jobs.id, id)).run();

    const second = claimNext()!;
    expect(second.attempts).toBe(2);
    fail(second, new Error('boom again'));
    expect(getJob(id)?.status).toBe('failed');
  });

  it('grows the backoff and caps it', () => {
    expect(backoffSeconds(1)).toBe(10);
    expect(backoffSeconds(3)).toBe(40);
    expect(backoffSeconds(20)).toBe(900);
  });

  it('releases claims whose worker died', () => {
    const id = enqueue('noop')!;
    claimNext();
    db()
      .update(jobs)
      .set({ claimedAt: 0, heartbeatAt: 0 })
      .where(eq(jobs.id, id))
      .run();
    expect(reapStaleClaims()).toBe(1);
    expect(getJob(id)?.status).toBe('pending');
    complete(id);
  });

  it('persists checkpoints so an interrupted job resumes', () => {
    const id = enqueue('noop', { steps: 10 })!;
    saveProgress(id, { progress: 0.4, label: 'step 4/10', checkpoint: 4 });
    const job = getJob(id)!;
    expect(job.checkpoint).toBe(4);
    expect(job.progress).toBeCloseTo(0.4);
    complete(id);
  });
});

describe('job runner', () => {
  it('runs a handler to completion and records progress', async () => {
    const id = enqueue('noop', { steps: 3, sleepMs: 0 })!;
    const processed = await new JobRunner().drain();
    expect(processed).toBeGreaterThanOrEqual(1);
    const job = getJob(id)!;
    expect(job.status).toBe('done');
    expect(job.progress).toBe(1);
  });

  it('fails permanently when no handler exists', async () => {
    db()
      .insert(jobs)
      .values({ type: 'nonexistent_type', payload: {} })
      .run();
    const row = db().select().from(jobs).where(eq(jobs.type, 'nonexistent_type')).get()!;
    await new JobRunner().drain();
    expect(getJob(row.id)?.status).toBe('failed');
    expect(getJob(row.id)?.lastError).toContain('no handler registered');
  });

  it('resumes from a checkpoint rather than starting over', async () => {
    const seen: number[] = [];
    register('cluster_posts', async (ctx) => {
      const start = typeof ctx.checkpoint === 'number' ? ctx.checkpoint : 0;
      for (let i = start; i < 5; i++) {
        seen.push(i);
        ctx.save({ checkpoint: i + 1 });
      }
    });

    const id = enqueue('cluster_posts', {})!;
    saveProgress(id, { checkpoint: 3 });
    await new JobRunner().drain(['cluster_posts']);

    expect(seen).toEqual([3, 4]);
    expect(getJob(id)?.status).toBe('done');
  });
});
