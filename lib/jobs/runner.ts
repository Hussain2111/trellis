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
import { JobPermanentError, JobYield, parsePayload, type JobContext, type JobType } from './types';

/**
 * Single-concurrency runner. One job at a time is deliberate: on a 15W U-series
 * chip, two concurrent model calls are slower than two sequential ones, and a
 * transcription queue running beside a scan will make the UI stutter.
 */
export class JobRunner {
  private stopping = false;
  private controller = new AbortController();
  private current: Job | null = null;

  stop(): void {
    this.stopping = true;
    this.controller.abort();
  }

  get busy(): boolean {
    return this.current !== null;
  }

  /** Run every runnable job until the queue is empty or a stop is requested. */
  async drain(types?: JobType[]): Promise<number> {
    reapStaleClaims();
    let processed = 0;
    while (!this.stopping) {
      const job = claimNext(types);
      if (!job) break;
      await this.run(job);
      processed++;
    }
    return processed;
  }

  private async run(job: Job): Promise<void> {
    this.current = job;
    const handler = getHandler(job.type);
    if (!handler) {
      fail(job, new JobPermanentError(`no handler registered for job type "${job.type}"`), true);
      this.current = null;
      return;
    }

    const beat = setInterval(() => heartbeat(job.id), 15_000);
    let yielded = false;

    try {
      markRunning(job.id);
      const payload = parsePayload(job.type as JobType, job.payload);
      const ctx: JobContext = {
        jobId: job.id,
        type: job.type as JobType,
        payload,
        checkpoint: job.checkpoint,
        attempt: job.attempts,
        save: (update) => saveProgress(job.id, update),
        shouldStop: () => this.stopping,
        signal: this.controller.signal,
      };
      await handler(ctx);

      if (this.stopping) {
        // The handler checkpointed on the way out; put it back for next start.
        requeue(job.id);
        yielded = true;
      } else {
        complete(job.id);
      }
    } catch (error) {
      if (error instanceof JobYield) {
        requeue(job.id, 5);
        yielded = true;
      } else if (error instanceof JobPermanentError) {
        fail(job, error, true);
      } else {
        fail(job, error);
      }
    } finally {
      clearInterval(beat);
      this.current = null;
      void yielded;
    }
  }
}
