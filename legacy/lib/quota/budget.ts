import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { quotaBudget } from '../db/schema';

/**
 * Free tiers are hostile and their published limits move. Nothing here is a
 * hardcoded quota: these are *self-imposed* daily allowances so one job type
 * can't eat the whole day, and the real limit is whatever the provider's
 * headers and 429s tell us. Observed values are persisted and win over defaults.
 */

export type JobType =
  | 'cluster_naming'
  | 'gap_analysis'
  | 'voice_profile'
  | 'draft_generation'
  | 'chat'
  | 'misc';

/** Self-imposed shares of a day, not provider limits. Chat yields first. */
export const DEFAULT_ALLOWANCES: Record<JobType, number> = {
  cluster_naming: 4,
  gap_analysis: 6,
  voice_profile: 3,
  draft_generation: 20,
  chat: 60,
  misc: 10,
};

/** Order in which job types give up headroom when the day runs short. */
export const YIELD_ORDER: JobType[] = [
  'chat',
  'misc',
  'draft_generation',
  'voice_profile',
  'gap_analysis',
  'cluster_naming',
];

const nowS = (): number => Math.floor(Date.now() / 1000);

function nextMidnight(): number {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function row(provider: string, jobType: JobType) {
  const existing = db()
    .select()
    .from(quotaBudget)
    .where(and(eq(quotaBudget.provider, provider), eq(quotaBudget.jobType, jobType)))
    .get();
  if (existing) return rollIfStale(existing);

  db()
    .insert(quotaBudget)
    .values({
      provider,
      jobType,
      dailyAllowance: DEFAULT_ALLOWANCES[jobType],
      consumedToday: 0,
      resetAt: nextMidnight(),
    })
    .onConflictDoNothing()
    .run();

  return db()
    .select()
    .from(quotaBudget)
    .where(and(eq(quotaBudget.provider, provider), eq(quotaBudget.jobType, jobType)))
    .get()!;
}

function rollIfStale(r: typeof quotaBudget.$inferSelect) {
  if (r.resetAt > nowS()) return r;
  db()
    .update(quotaBudget)
    .set({ consumedToday: 0, resetAt: nextMidnight(), exhaustedUntil: null })
    .where(eq(quotaBudget.id, r.id))
    .run();
  return { ...r, consumedToday: 0, resetAt: nextMidnight(), exhaustedUntil: null };
}

export interface Headroom {
  allowed: boolean;
  remaining: number;
  allowance: number;
  reason?: string;
  resetAt: number;
}

export function checkHeadroom(provider: string, jobType: JobType): Headroom {
  const r = row(provider, jobType);
  if (r.exhaustedUntil && r.exhaustedUntil > nowS()) {
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

export function consume(provider: string, jobType: JobType, n = 1): void {
  const r = row(provider, jobType);
  db()
    .update(quotaBudget)
    .set({ consumedToday: r.consumedToday + n })
    .where(eq(quotaBudget.id, r.id))
    .run();
}

/**
 * A 429 that means "today is over". Everything for this provider is parked
 * until the reset the provider named, or midnight if it named none.
 */
export function markDailyExhausted(provider: string, until?: number): void {
  const resetAt = until ?? nextMidnight();
  for (const jobType of Object.keys(DEFAULT_ALLOWANCES) as JobType[]) {
    const r = row(provider, jobType);
    db().update(quotaBudget).set({ exhaustedUntil: resetAt }).where(eq(quotaBudget.id, r.id)).run();
  }
}

/** Record a limit we actually observed in a response header. Never hardcode one. */
export function recordObservedLimit(provider: string, jobType: JobType, limit: number): void {
  const r = row(provider, jobType);
  db()
    .update(quotaBudget)
    .set({ observedLimit: limit, observedAt: nowS() })
    .where(eq(quotaBudget.id, r.id))
    .run();
}

export function setAllowance(provider: string, jobType: JobType, allowance: number): void {
  const r = row(provider, jobType);
  db().update(quotaBudget).set({ dailyAllowance: allowance }).where(eq(quotaBudget.id, r.id)).run();
}

export function allBudgets() {
  return db().select().from(quotaBudget).all().map(rollIfStale);
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
