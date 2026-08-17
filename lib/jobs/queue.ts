import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { jobs, type Job } from '../db/schema';
import { parsePayload, type JobType } from './types';

/**
 * A claim older than this is assumed dead — the invocation that held it was
 * killed mid-step by Vercel's function timeout. The next cron tick or webhook
 * reclaims it.
 */
export const STALE_CLAIM_SECONDS = 120;

export interface EnqueueOptions {
  priority?: number;
  runAfter?: Date;
  maxAttempts?: number;
  /** Skip if an unfinished job of this type already exists. */
  dedupe?: boolean;
}

export async function enqueue<T extends JobType>(
  type: T,
  payload: unknown = {},
  options: EnqueueOptions = {},
): Promise<number | null> {
  const validated = parsePayload(type, payload);

  if (options.dedupe) {
    const [existing] = await db()
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, type),
          inArray(jobs.status, ['pending', 'claimed', 'running', 'waiting']),
        ),
      )
      .limit(1);
    if (existing) return null;
  }

  const [row] = await db()
    .insert(jobs)
    .values({
      type,
      payload: validated,
      priority: options.priority ?? 0,
      maxAttempts: options.maxAttempts ?? 3,
      ...(options.runAfter ? { runAfter: options.runAfter } : {}),
    })
    .returning({ id: jobs.id });

  return row?.id ?? null;
}

/**
 * Atomically claim the next runnable job via `FOR UPDATE SKIP LOCKED`, so
 * concurrent invocations (a cron tick and a webhook landing at the same
 * moment) can never claim the same row.
 */
export async function claimNext(types?: JobType[]): Promise<Job | null> {
  const typeFilter = types?.length ? sql`AND type = ANY(${types})` : sql``;
  const rows = await db().execute<Job>(sql`
    UPDATE jobs
       SET status = 'claimed', claimed_at = now(), heartbeat_at = now(), attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs
        WHERE status = 'pending'
          AND run_after <= now()
          ${typeFilter}
        ORDER BY priority DESC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING *
  `);
  const row = rows[0];
  return row ? hydrate(row) : null;
}

/** Return claims whose invocation died back to `pending`. Call at the start of every tick. */
export async function reapStaleClaims(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_CLAIM_SECONDS * 1000);
  const result = await db()
    .update(jobs)
    .set({ status: 'pending', claimedAt: null, heartbeatAt: null })
    .where(
      and(
        inArray(jobs.status, ['claimed', 'running']),
        lt(sql`coalesce(${jobs.heartbeatAt}, ${jobs.claimedAt}, to_timestamp(0))`, cutoff),
      ),
    )
    .returning({ id: jobs.id });
  return result.length;
}

export async function markRunning(id: number): Promise<void> {
  await db()
    .update(jobs)
    .set({ status: 'running', startedAt: new Date(), heartbeatAt: new Date() })
    .where(eq(jobs.id, id));
}

export async function heartbeat(id: number): Promise<void> {
  await db().update(jobs).set({ heartbeatAt: new Date() }).where(eq(jobs.id, id));
}

export async function saveProgress(
  id: number,
  update: { progress?: number; label?: string; checkpoint?: unknown },
): Promise<void> {
  const patch: Partial<Job> = { heartbeatAt: new Date() };
  if (update.progress !== undefined) patch.progress = Math.max(0, Math.min(1, update.progress));
  if (update.label !== undefined) patch.progressLabel = update.label;
  if (update.checkpoint !== undefined) patch.checkpoint = update.checkpoint;
  await db().update(jobs).set(patch).where(eq(jobs.id, id));
}

/** Mark a job waiting on an external callback (e.g. an Apify actor run) rather than done or failed. */
export async function markWaiting(id: number, checkpoint: unknown): Promise<void> {
  await db()
    .update(jobs)
    .set({ status: 'waiting', checkpoint, heartbeatAt: new Date() })
    .where(eq(jobs.id, id));
}

/** Resume a waiting job — e.g. a webhook landed. Puts it back in the claimable pool. */
export async function resume(id: number, runAfter?: Date): Promise<void> {
  await db()
    .update(jobs)
    .set({
      status: 'pending',
      claimedAt: null,
      heartbeatAt: null,
      runAfter: runAfter ?? new Date(),
    })
    .where(and(eq(jobs.id, id), eq(jobs.status, 'waiting')));
}

export async function complete(id: number): Promise<void> {
  await db()
    .update(jobs)
    .set({ status: 'done', progress: 1, finishedAt: new Date(), lastError: null })
    .where(eq(jobs.id, id));
}

/** Put a yielded job back in the queue without consuming a retry. */
export async function requeue(id: number, delaySeconds = 0): Promise<void> {
  await db()
    .update(jobs)
    .set({
      status: 'pending',
      claimedAt: null,
      heartbeatAt: null,
      attempts: sql`greatest(${jobs.attempts} - 1, 0)`,
      runAfter: new Date(Date.now() + delaySeconds * 1000),
    })
    .where(eq(jobs.id, id));
}

/** Exponential backoff, capped so a stuck job still retries within the hour. */
export function backoffSeconds(attempt: number): number {
  return Math.min(2 ** attempt * 5, 900);
}

export async function fail(job: Job, error: unknown, permanent = false): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = permanent || job.attempts >= job.maxAttempts;
  if (exhausted) {
    await db()
      .update(jobs)
      .set({ status: 'failed', lastError: message, finishedAt: new Date() })
      .where(eq(jobs.id, job.id));
    return;
  }
  await db()
    .update(jobs)
    .set({
      status: 'pending',
      claimedAt: null,
      heartbeatAt: null,
      lastError: message,
      runAfter: new Date(Date.now() + backoffSeconds(job.attempts) * 1000),
    })
    .where(eq(jobs.id, job.id));
}

export async function cancel(id: number): Promise<void> {
  await db()
    .update(jobs)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(
      and(eq(jobs.id, id), inArray(jobs.status, ['pending', 'claimed', 'running', 'waiting'])),
    );
}

export async function getJob(id: number): Promise<Job | null> {
  const [row] = await db().select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return row ?? null;
}

export async function listJobs(limit = 50): Promise<Job[]> {
  return db().select().from(jobs).orderBy(desc(jobs.id)).limit(limit);
}

export async function activeJobs(): Promise<Job[]> {
  return db()
    .select()
    .from(jobs)
    .where(inArray(jobs.status, ['pending', 'claimed', 'running', 'waiting']))
    .orderBy(desc(jobs.priority), jobs.id);
}

function hydrate(row: Job): Job {
  return row;
}
