import { env } from '../../env';
import { getApifySpend } from '../../ingest/budget';
import { isScanDue, listAccounts, selfAccount } from '../../ingest/upsert';
import { enqueue } from '../queue';
import { JobPermanentError, type JobContext } from '../types';

/**
 * The weekly Apify pass: everything that costs credit, batched into one
 * scheduled run instead of chaining off whatever the user happened to do.
 *
 * v1 chained discovery onto every self-account scan, which meant the
 * expensive path fired on the cheapest trigger. v2 separates them: the
 * account's own data syncs daily and free through the Graph API, and the
 * scraped niche refreshes once a week.
 *
 * This enqueues rather than scrapes. Each child job hits the budget guard on
 * its own, so a month that runs dry stops spending part-way through the list
 * instead of failing the whole sweep.
 */
export async function weeklyNiche(ctx: JobContext<'weekly_niche'>): Promise<void> {
  const e = env();
  const self = await selfAccount();
  if (!self) throw new JobPermanentError('no self account configured yet');

  const spend = await getApifySpend(e.APIFY_MONTHLY_CREDIT_USD);
  if (spend.remainingUsd <= 0) {
    await ctx.save({
      progress: 1,
      label: `budget spent ($${spend.spentUsd.toFixed(2)} of $${spend.monthlyAllowanceUsd.toFixed(2)}) — skipping`,
    });
    return;
  }

  await ctx.save({ progress: 0.2, label: 'refreshing the competitor pool' });

  // Discovery reads the managed account's captions for hashtags. Those posts
  // are Graph-sourced now, but they are the same `posts` rows, so nothing in
  // the discovery path had to change.
  await enqueue('discover_competitors', { accountId: self.id }, { dedupe: true });

  const competitors = await listAccounts('competitor');
  const due = competitors.filter((a) => isScanDue(a, ctx.payload.cooldownDays));

  for (const competitor of due) {
    await enqueue('scan_account', { accountId: competitor.id, limit: 20 }, { dedupe: true });
  }

  await ctx.save({
    progress: 1,
    label: `discovery queued, ${due.length} of ${competitors.length} competitor(s) due for re-scan`,
    checkpoint: {
      queued: due.map((a) => a.handle),
      remainingBudgetUsd: spend.remainingUsd,
    },
  });
}
