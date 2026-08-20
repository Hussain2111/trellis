import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { generations, runs, type Generation } from '../db/schema';
import { riyadhDay, startOfDayRiyadh, startOfWeekRiyadh } from '../time';

/**
 * Read/write for the cached interpretation layer.
 *
 * Generation happens on the weekly cron. Page loads read this table and never
 * call a model — a model call per request would spend the Gemini free-tier
 * rate limit on page views and make browsing cost something, which the
 * $0/month constraint does not allow.
 */

export type GenerationKind = 'opportunities' | 'weekly';

/** How many manual regenerations are allowed per kind per Riyadh day. */
export const REGENERATE_DAILY_CAP = 5;

export function currentWeekStart(now: Date = new Date()): string {
  return riyadhDay(startOfWeekRiyadh(now));
}

export async function readGeneration(
  kind: GenerationKind,
  weekStart: string,
): Promise<Generation | null> {
  const [row] = await db()
    .select()
    .from(generations)
    .where(and(eq(generations.kind, kind), eq(generations.weekStart, weekStart)))
    .limit(1);
  return row ?? null;
}

/** Every week we hold a generation for, newest first — backs the archive dropdown. */
export async function listGeneratedWeeks(
  kind: GenerationKind,
  limit = 26,
): Promise<{ weekStart: string; status: string; createdAt: Date }[]> {
  return db()
    .select({
      weekStart: generations.weekStart,
      status: generations.status,
      createdAt: generations.createdAt,
    })
    .from(generations)
    .where(eq(generations.kind, kind))
    .orderBy(desc(generations.weekStart))
    .limit(limit);
}

export async function writeGeneration(input: {
  kind: GenerationKind;
  weekStart: string;
  payload: unknown;
  output: unknown;
  status: 'ok' | 'fallback';
  validationNotes: string[];
  generatedBy: string;
}): Promise<void> {
  const values = {
    payload: input.payload,
    output: input.output,
    status: input.status,
    validationNotes: input.validationNotes,
    generatedBy: input.generatedBy,
    createdAt: new Date(),
  };
  await db()
    .insert(generations)
    .values({ kind: input.kind, weekStart: input.weekStart, ...values })
    .onConflictDoUpdate({
      target: [generations.kind, generations.weekStart],
      set: values,
    });
}

/**
 * Manual regeneration is rate-limited against the `runs` ledger rather than a
 * counter column, because a regeneration that failed still spent quota and
 * still has to count. Counting stored rows would let a loop of failures run
 * free.
 */
export async function regenerationsToday(kind: GenerationKind): Promise<number> {
  const since = startOfDayRiyadh();
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(runs)
    .where(
      and(
        eq(runs.operation, `generate_${kind}`),
        gte(runs.createdAt, since),
        sql`${runs.meta}->>'trigger' = 'manual'`,
      ),
    );
  return row?.n ?? 0;
}

export async function recordRegenerationAttempt(kind: GenerationKind): Promise<void> {
  await db()
    .insert(runs)
    .values({
      provider: 'google',
      operation: `generate_${kind}`,
      status: 'ok',
      costEstimate: 0,
      freeTier: true,
      meta: { trigger: 'manual' },
    });
}
