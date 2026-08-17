import { z } from 'zod';

/**
 * Every long-running operation is a row in `jobs`. Nothing in the UI blocks on
 * a model call — it enqueues, then watches progress.
 *
 * Payload schemas live here so both the enqueuer and the handler validate
 * against the same shape.
 */

export const jobPayloads = {
  scan_account: z.object({
    accountId: z.number().int(),
    limit: z.number().int().positive().default(100),
    incremental: z.boolean().default(true),
  }),
  compute_features: z.object({
    accountId: z.number().int().optional(),
  }),
  transcribe_reels: z.object({
    cap: z.number().int().positive().default(150),
  }),
  embed_posts: z.object({
    model: z.string().optional(),
  }),
  cluster_posts: z.object({
    kMin: z.number().int().positive().default(8),
    kMax: z.number().int().positive().default(20),
  }),
  run_analysis: z.object({
    windowDays: z.number().int().positive().default(30),
  }),
  build_voice_profile: z.object({
    topN: z.number().int().positive().default(20),
  }),
  generate_drafts: z.object({
    analysisId: z.number().int(),
    count: z.number().int().positive().default(12),
  }),
  render_slides: z.object({
    draftId: z.number().int(),
  }),
  publish_due: z.object({}),
  refresh_ig_token: z.object({}),
  /** No-op used by the M0 smoke test and by `worker --selftest`. */
  noop: z.object({
    steps: z.number().int().positive().default(3),
    sleepMs: z.number().int().nonnegative().default(50),
  }),
} as const;

export type JobType = keyof typeof jobPayloads;

export type JobPayload<T extends JobType> = z.infer<(typeof jobPayloads)[T]>;

export const JOB_TYPES = Object.keys(jobPayloads) as JobType[];

export function parsePayload<T extends JobType>(type: T, payload: unknown): JobPayload<T> {
  return jobPayloads[type].parse(payload) as JobPayload<T>;
}

/** What a handler receives. `checkpoint` is whatever it last saved. */
export interface JobContext<T extends JobType = JobType> {
  jobId: number;
  type: T;
  payload: JobPayload<T>;
  checkpoint: unknown;
  attempt: number;
  /** Persist progress and a resume point. Safe to call often. */
  save(update: { progress?: number; label?: string; checkpoint?: unknown }): void;
  /** True once a shutdown has been requested — handlers should checkpoint and return. */
  shouldStop(): boolean;
  signal: AbortSignal;
}

export type JobHandler<T extends JobType = JobType> = (ctx: JobContext<T>) => Promise<void>;

/** Thrown by a handler that stopped cleanly at a checkpoint and wants a re-run. */
export class JobYield extends Error {
  constructor(message = 'job yielded at checkpoint') {
    super(message);
    this.name = 'JobYield';
  }
}

/** Thrown when retrying is pointless (bad payload, missing binary, hard 4xx). */
export class JobPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobPermanentError';
  }
}
