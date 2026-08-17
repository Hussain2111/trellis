import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { quotaBudget, type QuotaBudget } from '../db/schema';

/**
 * Free tiers are hostile and their published limits move. Nothing here is a
 * hardcoded quota: these are *self-imposed* daily allowances so one job type
 * can't eat the whole day, and the real limit is whatever the provider's
 * headers and 429s tell us. Observed values are persisted and win over defaults.
 */

export type JobType =
  | 'niche_inference'
  | 'hook_classification'
  | 'gap_analysis'
  | 'voice_profile'
  | 'draft_generation'
  | 'chat'
  | 'misc';

/**
 * Self-imposed shares of a day, not provider limits. Hook classification is
 * one call per post, so it gets the largest share by far; chat yields first
 * when the day runs short.
 */
export const DEFAULT_ALLOWANCES: Record<JobType, number> = {
  niche_inference: 5,
  hook_classification: 300,
  gap_analysis: 10,
  voice_profile: 5,
  draft_generation: 30,
  chat: 60,
  misc: 20,
};

/** Order in which job types give up headroom when the day runs short. */
export const YIELD_ORDER: JobType[] = [
  'chat',
  'misc',
  'draft_generation',
  'voice_profile',
  'gap_analysis',
  'niche_inference',
  'hook_classification',
];

function nextMidnight(): Date {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d;
}

async function row(provider: string, jobType: JobType): Promise<QuotaBudget> {
  const [existing] = await db()
    .select()
    .from(quotaBudget)
    .where(and(eq(quotaBudget.provider, provider), eq(quotaBudget.jobType, jobType)))
    .limit(1);
  if (existing) return rollIfStale(existing);

  await db()
    .insert(quotaBudget)
    .values({
      provider,
      jobType,
      dailyAllowance: DEFAULT_ALLOWANCES[jobType],
      consumedToday: 0,
      resetAt: nextMidnight(),
    })
    .onConflictDoNothing();

  const [created] = await db()
    .select()
    .from(quotaBudget)
    .where(and(eq(quotaBudget.provider, provider), eq(quotaBudget.jobType, jobType)))
    .limit(1);
  return created!;
}

async function rollIfStale(r: QuotaBudget): Promise<QuotaBudget> {
  if (r.resetAt.getTime() > Date.now()) return r;
  const reset = nextMidnight();
  await db()
    .update(quotaBudget)
    .set({ consumedToday: 0, resetAt: reset, exhaustedUntil: null })
    .where(eq(quotaBudget.id, r.id));
  return { ...r, consumedToday: 0, resetAt: reset, exhaustedUntil: null };
}

export interface Headroom {
  allowed: boolean;
  remaining: number;
  allowance: number;
  reason?: string;
  resetAt: Date;
}

export async function checkHeadroom(provider: string, jobType: JobType): Promise<Headroom> {
  const r = await row(provider, jobType);
  if (r.exhaustedUntil && r.exhaustedUntil.getTime() > Date.now()) {
    return {
      allowed: false,
      remaining: 0,
      allowance: r.dailyAllowance,
      reason: 'provider reported daily exhaustion',
      resetAt: r.exhaustedUntil,
    };
  }
  const remaining = r.dailyAllowance - r.consumedToday;
  return {
    allowed: remaining > 0,
    remaining: Math.max(0, remaining),
    allowance: r.dailyAllowance,
    ...(remaining > 0 ? {} : { reason: 'daily allowance for this job type spent' }),
    resetAt: r.resetAt,
  };
}

export async function consume(provider: string, jobType: JobType, n = 1): Promise<void> {
  const r = await row(provider, jobType);
  await db()
    .update(quotaBudget)
    .set({ consumedToday: r.consumedToday + n })
    .where(eq(quotaBudget.id, r.id));
}

/**
 * A 429 that means "today is over". Everything for this provider is parked
 * until the reset the provider named, or midnight if it named none.
 */
export async function markDailyExhausted(provider: string, until?: Date): Promise<void> {
  const resetAt = until ?? nextMidnight();
  for (const jobType of Object.keys(DEFAULT_ALLOWANCES) as JobType[]) {
    const r = await row(provider, jobType);
    await db().update(quotaBudget).set({ exhaustedUntil: resetAt }).where(eq(quotaBudget.id, r.id));
  }
}

/** Record a limit we actually observed in a response header. Never hardcode one. */
export async function recordObservedLimit(
  provider: string,
  jobType: JobType,
  limit: number,
): Promise<void> {
  const r = await row(provider, jobType);
  await db()
    .update(quotaBudget)
    .set({ observedLimit: limit, observedAt: new Date() })
    .where(eq(quotaBudget.id, r.id));
}

export async function setAllowance(
  provider: string,
  jobType: JobType,
  allowance: number,
): Promise<void> {
  const r = await row(provider, jobType);
  await db().update(quotaBudget).set({ dailyAllowance: allowance }).where(eq(quotaBudget.id, r.id));
}

export async function allBudgets(): Promise<QuotaBudget[]> {
  const rows = await db().select().from(quotaBudget);
  return Promise.all(rows.map(rollIfStale));
}

/**
 * Classify a provider error. Per-minute limits are control flow (back off and
 * retry); a daily limit means queue the work and tell the user to come back.
 */
export type QuotaKind = 'per_minute' | 'daily' | 'none';

export function classifyQuotaError(error: unknown): { kind: QuotaKind; retryAfterS?: number } {
  const message = error instanceof Error ? error.message : String(error);
  if (!/429|quota|rate.?limit|resource.?exhausted/i.test(message)) return { kind: 'none' };

  const retryMatch = /retry(?:-|\s)?after[":\s]*(\d+)/i.exec(message);
  const retryAfterS = retryMatch?.[1] ? Number(retryMatch[1]) : undefined;

  if (/per.?day|daily|requests per day|PerDay/i.test(message)) {
    return retryAfterS === undefined ? { kind: 'daily' } : { kind: 'daily', retryAfterS };
  }
  if (retryAfterS !== undefined && retryAfterS > 3600) return { kind: 'daily', retryAfterS };
  return retryAfterS === undefined ? { kind: 'per_minute' } : { kind: 'per_minute', retryAfterS };
}
