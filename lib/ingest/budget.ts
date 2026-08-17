import { and, gte, sql } from 'drizzle-orm';
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

export function budgetState(monthlyAllowanceUsd: number): BudgetState {
  const start = startOfMonthSeconds();
  const row = db()
    .select({
      spent: sql<number>`coalesce(sum(${runs.costEstimate}), 0)`,
      items: sql<number>`coalesce(sum(json_extract(${runs.meta}, '$.items')), 0)`,
    })
    .from(runs)
    .where(and(gte(runs.createdAt, start), sql`${runs.provider} = 'apify'`))
    .get();

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

export function estimateCost(items: number, monthlyAllowanceUsd: number): {
  items: number;
  costUsd: number;
  remainingAfterUsd: number;
  affordable: boolean;
  note: string;
} {
  const state = budgetState(monthlyAllowanceUsd);
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

function startOfMonthSeconds(): number {
  const d = new Date();
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
}
