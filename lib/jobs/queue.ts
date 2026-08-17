import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { db, sqlite } from '../db/client';
import { jobs, type Job } from '../db/schema';
import { parsePayload, type JobType } from './types';

const nowS = (): number => Math.floor(Date.now() / 1000);

/** A claim older than this is assumed dead — the process was killed mid-job. */
export const STALE_CLAIM_SECONDS = 120;

export interface EnqueueOptions {
  priority?: number;
  runAfter?: number;
  maxAttempts?: number;
  /** Skip if an unfinished job of this type already exists. */
  dedupe?: boolean;
}

export function enqueue<T extends JobType>(
  type: T,
  payload: unknown = {},
  options: EnqueueOptions = {},
): number | null {
  const validated = parsePayload(type, payload);

  if (options.dedupe) {
    const existing = db()
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.type, type), inArray(jobs.status, ['pending', 'claimed', 'running'])))
      .get();
    if (existing) return null;
  }

  const row = db()
    .insert(jobs)
    .values({
      type,
      payload: validated,
      priority: options.priority ?? 0,
      maxAttempts: options.maxAttempts ?? 3,
      runAfter: options.runAfter ?? nowS(),
    })
    .returning({ id: jobs.id })
    .get();

  return row.id;
}

/**
 * Atomically claim the next runnable job. The UPDATE ... WHERE id = (SELECT ...)
 * is a single statement, so two workers can never claim the same row even
 * though they are separate processes on the same SQLite file.
 */
export function claimNext(types?: JobType[]): Job | null {
  const raw = sqlite();
  const typeFilter = types?.length ? `AND type IN (${types.map(() => '?').join(',')})` : '';
  const stmt = raw.prepare(`
    UPDATE jobs
       SET status = 'claimed', claimed_at = ?, heartbeat_at = ?, attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs
        WHERE status = 'pending'
          AND run_after <= ?
          ${typeFilter}
        ORDER BY priority DESC, id ASC
        LIMIT 1
     )
    RETURNING *
  `);
  const t = nowS();
  const params: (number | string)[] = [t, t, t, ...(types ?? [])];
  const row = stmt.get(...params) as Record<string, unknown> | undefined;
  if (!row) return null;
  return hydrate(row);
}

/** Return claims whose worker died back to `pending`. Called on worker start and on each tick. */
export function reapStaleClaims(): number {
  const cutoff = nowS() - STALE_CLAIM_SECONDS;
  const result = db()
    .update(jobs)
    .set({ status: 'pending', claimedAt: null, heartbeatAt: null })
    .where(
      and(
        inArray(jobs.status, ['claimed', 'running']),
        lt(sql`coalesce(${jobs.heartbeatAt}, ${jobs.claimedAt}, 0)`, cutoff),
      ),
    )
    .run();
  return result.changes;
}

export function markRunning(id: number): void {
  db()
    .update(jobs)
    .set({ status: 'running', startedAt: nowS(), heartbeatAt: nowS() })
    .where(eq(jobs.id, id))
    .run();
}

export function heartbeat(id: number): void {
  db().update(jobs).set({ heartbeatAt: nowS() }).where(eq(jobs.id, id)).run();
}

export function saveProgress(
  id: number,
  update: { progress?: number; label?: string; checkpoint?: unknown },
): void {
  const patch: Record<string, unknown> = { heartbeatAt: nowS() };
  if (update.progress !== undefined) patch.progress = Math.max(0, Math.min(1, update.progress));
  if (update.label !== undefined) patch.progressLabel = update.label;
  if (update.checkpoint !== undefined) patch.checkpoint = update.checkpoint;
  db().update(jobs).set(patch).where(eq(jobs.id, id)).run();
}

export function complete(id: number): void {
  db()
    .update(jobs)
    .set({ status: 'done', progress: 1, finishedAt: nowS(), lastError: null })
    .where(eq(jobs.id, id))
    .run();
}

/** Put a yielded job back in the queue without consuming a retry. */
export function requeue(id: number, delaySeconds = 0): void {
  db()
    .update(jobs)
    .set({
      status: 'pending',
      claimedAt: null,
      heartbeatAt: null,
      attempts: sql`max(${jobs.attempts} - 1, 0)`,
      runAfter: nowS() + delaySeconds,
    })
    .where(eq(jobs.id, id))
    .run();
}

/** Exponential backoff, capped so a stuck job still retries within the hour. */
export function backoffSeconds(attempt: number): number {
  return Math.min(2 ** attempt * 5, 900);
}

export function fail(job: Job, error: unknown, permanent = false): void {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = permanent || job.attempts >= job.maxAttempts;
  if (exhausted) {
    db()
      .update(jobs)
      .set({ status: 'failed', lastError: message, finishedAt: nowS() })
      .where(eq(jobs.id, job.id))
      .run();
    return;
  }
  db()
    .update(jobs)
    .set({
      status: 'pending',
      claimedAt: null,
      heartbeatAt: null,
      lastError: message,
      runAfter: nowS() + backoffSeconds(job.attempts),
    })
    .where(eq(jobs.id, job.id))
    .run();
}

export function cancel(id: number): void {
  db()
    .update(jobs)
    .set({ status: 'cancelled', finishedAt: nowS() })
    .where(and(eq(jobs.id, id), inArray(jobs.status, ['pending', 'claimed', 'running'])))
    .run();
}

export function getJob(id: number): Job | null {
  return db().select().from(jobs).where(eq(jobs.id, id)).get() ?? null;
}

export function listJobs(limit = 50): Job[] {
  return db().select().from(jobs).orderBy(desc(jobs.id)).limit(limit).all();
}

export function activeJobs(): Job[] {
  return db()
    .select()
    .from(jobs)
    .where(inArray(jobs.status, ['pending', 'claimed', 'running']))
    .orderBy(desc(jobs.priority), jobs.id)
    .all();
}

function hydrate(row: Record<string, unknown>): Job {
  // better-sqlite3 returns raw columns; Drizzle's json/boolean mapping is
  // bypassed by the raw RETURNING above, so decode by hand.
  const json = (v: unknown): unknown =>
    typeof v === 'string' && v.length > 0 ? JSON.parse(v) : (v ?? null);
  return {
    id: row.id as number,
    type: row.type as string,
    payload: json(row.payload),
    status: row.status as Job['status'],
    priority: row.priority as number,
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    checkpoint: json(row.checkpoint),
    progress: row.progress as number,
    progressLabel: (row.progress_label as string) ?? null,
    lastError: (row.last_error as string) ?? null,
    runAfter: row.run_after as number,
    claimedAt: (row.claimed_at as number) ?? null,
    heartbeatAt: (row.heartbeat_at as number) ?? null,
    startedAt: (row.started_at as number) ?? null,
    finishedAt: (row.finished_at as number) ?? null,
    createdAt: row.created_at as number,
  };
}
