import { and, desc, gte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { runs } from '../db/schema';

export interface RunRecord {
  provider: string;
  model?: string | null;
  operation: string;
  tier?: 'A' | 'B' | 'none';
  costEstimate?: number;
  freeTier?: boolean;
  promptTokens?: number | null;
  completionTokens?: number | null;
  durationMs?: number | null;
  status: 'ok' | 'error' | 'quota' | 'skipped';
  error?: string | null;
  meta?: unknown;
}

/** Every external call is logged, whether it succeeded or not. */
export function recordRun(record: RunRecord): number {
  const row = db()
    .insert(runs)
    .values({
      provider: record.provider,
      model: record.model ?? null,
      operation: record.operation,
      tier: record.tier ?? 'none',
      costEstimate: record.costEstimate ?? 0,
      freeTier: record.freeTier ?? true,
      promptTokens: record.promptTokens ?? null,
      completionTokens: record.completionTokens ?? null,
      durationMs: record.durationMs ?? null,
      status: record.status,
      error: record.error ?? null,
      meta: record.meta ?? null,
    })
    .returning({ id: runs.id })
    .get();
  return row.id;
}

/** Wrap an external call so it is timed and logged whichever way it goes. */
export async function withRun<T>(
  base: Omit<RunRecord, 'status' | 'durationMs'>,
  fn: () => Promise<{ result: T; tokens?: { prompt?: number; completion?: number } }>,
): Promise<T> {
  const started = Date.now();
  try {
    const { result, tokens } = await fn();
    recordRun({
      ...base,
      status: 'ok',
      durationMs: Date.now() - started,
      promptTokens: tokens?.prompt ?? null,
      completionTokens: tokens?.completion ?? null,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordRun({
      ...base,
      status: /quota|429|rate.?limit/i.test(message) ? 'quota' : 'error',
      durationMs: Date.now() - started,
      error: message,
    });
    throw error;
  }
}

export interface CostSummary {
  monthToDateUsd: number;
  callCount: number;
  paidCallCount: number;
  byProvider: { provider: string; calls: number; costUsd: number; freeTier: boolean }[];
}

/** Settings shows this. It should read $0.00. */
export function monthlyCostSummary(): CostSummary {
  const start = startOfMonthSeconds();
  const rows = db()
    .select({
      provider: runs.provider,
      calls: sql<number>`count(*)`,
      cost: sql<number>`coalesce(sum(${runs.costEstimate}), 0)`,
      free: sql<number>`min(${runs.freeTier})`,
    })
    .from(runs)
    .where(gte(runs.createdAt, start))
    .groupBy(runs.provider)
    .all();

  const byProvider = rows.map((r) => ({
    provider: r.provider,
    calls: Number(r.calls),
    costUsd: Number(r.cost),
    freeTier: Number(r.free) === 1,
  }));

  return {
    monthToDateUsd: byProvider.reduce((sum, r) => sum + r.costUsd, 0),
    callCount: byProvider.reduce((sum, r) => sum + r.calls, 0),
    paidCallCount: db()
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(and(gte(runs.createdAt, start), sql`${runs.freeTier} = 0`))
      .get()?.n ?? 0,
    byProvider,
  };
}

export function recentRuns(limit = 50) {
  return db().select().from(runs).orderBy(desc(runs.id)).limit(limit).all();
}

function startOfMonthSeconds(): number {
  const d = new Date();
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
}
