import { z } from 'zod';

/**
 * Every long-running operation is a row in `jobs`. Nothing in an HTTP handler
 * blocks on a model call or a multi-minute scrape — it enqueues (or advances
 * one step and returns), and a cron tick or webhook resumes it later.
 *
 * Payload schemas live here so both the enqueuer and the handler validate
 * against the same shape. Handlers are added stage by stage; this registry is
 * written up front so the schema doesn't have to change shape later.
 */

export const jobPayloads = {
  scan_account: z.object({
    accountId: z.number().int(),
    limit: z.number().int().positive().default(100),
  }),
  discover_competitors: z.object({
    accountId: z.number().int(),
  }),
  scan_hashtag: z.object({
    hashtag: z.string().min(1),
    limit: z.number().int().positive().default(30),
  }),
  compute_features: z.object({
    accountId: z.number().int().optional(),
  }),
  classify_hooks: z.object({
    accountId: z.number().int().optional(),
  }),
  run_analysis: z.object({
    windowDays: z.number().int().positive().default(30),
  }),
  publish_due: z.object({}),
  refresh_ig_token: z.object({}),
  /** No-op used by the infra smoke test. */
  noop: z.object({
    steps: z.number().int().positive().default(3),
  }),
} as const;

export type JobType = keyof typeof jobPayloads;

export type JobPayload<T extends JobType> = z.infer<(typeof jobPayloads)[T]>;

export const JOB_TYPES = Object.keys(jobPayloads) as JobType[];

export function parsePayload<T extends JobType>(type: T, payload: unknown): JobPayload<T> {
  return jobPayloads[type].parse(payload) as JobPayload<T>;
}

export class JobPermanentError extends Error {}

/** Thrown by a handler to hand control back without spending a retry — e.g. still polling for child jobs. */
export class JobYield extends Error {
  readonly delaySeconds: number;
  constructor(message = 'yielded', delaySeconds = 5) {
    super(message);
    this.delaySeconds = delaySeconds;
  }
}

/**
 * Thrown by a handler that has already put the job in `waiting` status itself
 * (via `markWaiting`) before returning control — e.g. it fired an Apify actor
 * run and is now waiting on that run's webhook. The runner must not also call
 * `complete()` or `fail()` in this case; the webhook (or a future poll) does.
 */
export class JobWaiting extends Error {}

export interface JobContext<T extends JobType = JobType> {
  jobId: number;
  type: T;
  payload: JobPayload<T>;
  checkpoint: unknown;
  attempt: number;
  save(update: { progress?: number; label?: string; checkpoint?: unknown }): Promise<void>;
  deadline: number;
  timeRemainingMs(): number;
}

export type JobHandler<T extends JobType = JobType> = (ctx: JobContext<T>) => Promise<void>;
