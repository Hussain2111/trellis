import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { runs } from '../db/schema';

/**
 * Apify credits are the hardest monthly ceiling in this build — everything else
 * is genuinely unlimited or genuinely local. So no scan starts without an
 * estimate, and a scan that would exceed the month's allowance is refused
 * rather than truncated silently.
 *
 * The per-item price is an observed figure, not a promise: it's recalculated
 * from actual charges as runs accumulate.
 */

/** Apify's published rate for residential-proxy Instagram actors, per 1,000 items. */
const DEFAULT_USD_PER_1000_ITEMS = 2.3;

export interface BudgetState {
  monthlyAllowanceUsd: number;
  spentUsd: number;
  remainingUsd: number;
  itemsScraped: number;
  usdPerItem: number;
  estimatedItemsRemaining: number;
}

export async function budgetState(monthlyAllowanceUsd: number): Promise<BudgetState> {
  const start = startOfMonth();
  const [row] = await db()
    .select({
      spent: sql<number>`coalesce(sum(${runs.costEstimate}), 0)::float`,
      items: sql<number>`coalesce(sum((${runs.meta}->>'items')::numeric), 0)::float`,
    })
    .from(runs)
    .where(and(gte(runs.createdAt, start), eq(runs.provider, 'apify')));

  const spentUsd = Number(row?.spent ?? 0);
  const itemsScraped = Number(row?.items ?? 0);

  // Learn the real rate once there's enough history to mean anything.
  const usdPerItem =
    itemsScraped >= 100 && spentUsd > 0
      ? spentUsd / itemsScraped
      : DEFAULT_USD_PER_1000_ITEMS / 1000;

  const remainingUsd = Math.max(0, monthlyAllowanceUsd - spentUsd);

  return {
    monthlyAllowanceUsd,
    spentUsd,
    remainingUsd,
    itemsScraped,
    usdPerItem,
    estimatedItemsRemaining: Math.floor(remainingUsd / usdPerItem),
  };
}

export async function estimateCost(
  items: number,
  monthlyAllowanceUsd: number,
): Promise<{
  items: number;
  costUsd: number;
  remainingAfterUsd: number;
  affordable: boolean;
  note: string;
}> {
  const state = await budgetState(monthlyAllowanceUsd);
  const costUsd = items * state.usdPerItem;
  const remainingAfterUsd = state.remainingUsd - costUsd;
  const affordable = remainingAfterUsd >= 0;

  return {
    items,
    costUsd,
    remainingAfterUsd,
    affordable,
    note: affordable
      ? `~$${costUsd.toFixed(2)} of the $${state.remainingUsd.toFixed(2)} left this month ` +
        `(~$${(state.usdPerItem * 1000).toFixed(2)}/1,000 items${state.itemsScraped >= 100 ? ', observed' : ', estimated'}).`
      : `Would cost ~$${costUsd.toFixed(2)} but only $${state.remainingUsd.toFixed(2)} is left ` +
        `this month. Scrape at most ~${state.estimatedItemsRemaining} items, or wait for the reset.`,
  };
}

export class BudgetExceeded extends Error {
  constructor(note: string) {
    super(`Refusing to scrape: ${note}`);
    this.name = 'BudgetExceeded';
  }
}

/**
 * Records a scrape that the guard refused, in the same `runs` ledger every
 * real call writes to. One ledger, one source of truth: a skip is a thing
 * that happened to the budget, and it belongs next to the spends rather than
 * in a table of its own.
 */
export async function recordBudgetSkip(input: {
  operation: string;
  note: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await db()
    .insert(runs)
    .values({
      provider: 'apify',
      operation: input.operation,
      status: 'skipped',
      costEstimate: 0,
      error: input.note,
      meta: { reason: 'budget_skipped', ...(input.meta ?? {}) },
    });
}

export interface ApifySpend {
  monthlyAllowanceUsd: number;
  spentUsd: number;
  remainingUsd: number;
  itemsScraped: number;
  usdPer1000Items: number;
  observed: boolean;
}

/** Month-to-date Apify spend against the allowance, for Settings. */
export async function getApifySpend(monthlyAllowanceUsd: number): Promise<ApifySpend> {
  const state = await budgetState(monthlyAllowanceUsd);
  return {
    monthlyAllowanceUsd: state.monthlyAllowanceUsd,
    spentUsd: state.spentUsd,
    remainingUsd: state.remainingUsd,
    itemsScraped: state.itemsScraped,
    usdPer1000Items: state.usdPerItem * 1000,
    observed: state.itemsScraped >= 100,
  };
}

export interface BudgetSkip {
  operation: string;
  note: string | null;
  at: Date;
}

/** Recent scrapes the guard refused — surfaced in Settings, not swallowed. */
export async function getBudgetSkips(limit = 10): Promise<BudgetSkip[]> {
  const rows = await db()
    .select({ operation: runs.operation, note: runs.error, at: runs.createdAt })
    .from(runs)
    .where(
      and(
        eq(runs.provider, 'apify'),
        eq(runs.status, 'skipped'),
        sql`${runs.meta}->>'reason' = 'budget_skipped'`,
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(limit);
  return rows;
}

function startOfMonth(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
