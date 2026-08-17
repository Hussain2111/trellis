import type { Job } from '../db/schema';
import { getHandler } from './registry';
import {
  claimNext,
  complete,
  fail,
  heartbeat,
  markRunning,
  reapStaleClaims,
  requeue,
  saveProgress,
} from './queue';
import {
  JobPermanentError,
  JobWaiting,
  JobYield,
  parsePayload,
  type JobContext,
  type JobType,
} from './types';

export interface TickResult {
  processed: number;
  reaped: number;
}

/**
 * Run runnable jobs until the queue is empty or `budgetMs` is nearly spent.
 * Vercel Hobby functions have a hard wall-clock ceiling, so this never blocks
 * indefinitely like a persistent worker would — a cron tick (or a webhook
 * callback) calls this once and returns, and the next tick picks up where
 * this one left off via the job's `checkpoint`.
 */
export async function runTick(types?: JobType[], budgetMs = 8_000): Promise<TickResult> {
  const startedAt = Date.now();
  const reaped = await reapStaleClaims();
  let processed = 0;

  while (Date.now() - startedAt < budgetMs) {
    const job = await claimNext(types);
    if (!job) break;
    const remaining = budgetMs - (Date.now() - startedAt);
    await runOne(job, startedAt + budgetMs, remaining);
    processed++;
  }

  return { processed, reaped };
}

async function runOne(job: Job, deadline: number, remainingMs: number): Promise<void> {
  const handler = getHandler(job.type as JobType);
  if (!handler) {
    await fail(
      job,
      new JobPermanentError(`no handler registered for job type "${job.type}"`),
      true,
    );
    return;
  }

  try {
    await markRunning(job.id);
    const payload = parsePayload(job.type as JobType, job.payload);
    const ctx: JobContext = {
      jobId: job.id,
      type: job.type as JobType,
      payload,
      checkpoint: job.checkpoint,
      attempt: job.attempts,
      save: (update) => saveProgress(job.id, update),
      deadline,
      timeRemainingMs: () => deadline - Date.now(),
    };
    void remainingMs;
    await heartbeat(job.id);
    await handler(ctx);
    await complete(job.id);
  } catch (error) {
    if (error instanceof JobWaiting) {
      // The handler already moved the job to `waiting` via markWaiting() —
      // nothing more to do here. A webhook (or a future poll) resumes it.
    } else if (error instanceof JobYield) {
      await requeue(job.id, 5);
    } else if (error instanceof JobPermanentError) {
      await fail(job, error, true);
    } else {
      await fail(job, error);
    }
  }
}
