import { env } from '../../env';
import { getScraper } from '../../providers';
import { ApifyScraper } from '../../providers/scraper/apify';
import { getAccount } from '../../ingest/upsert';
import { recordSnapshot } from '../../insights/followers';
import { markWaiting } from '../queue';
import { JobPermanentError, JobWaiting, type JobContext } from '../types';

/**
 * Captures who currently follows the account. Manual-only and never on a
 * schedule: this is the single most expensive scrape in the build, and its
 * only purpose is to name the people a *free* daily count already told you
 * left. The button is the budget decision; this job just carries it out.
 *
 * Same fire-and-webhook shape as the other Apify jobs — see
 * `/api/webhooks/apify`.
 */
export async function snapshotFollowers(ctx: JobContext<'snapshot_followers'>): Promise<void> {
  const account = await getAccount(ctx.payload.accountId);
  if (!account) throw new JobPermanentError(`account ${ctx.payload.accountId} no longer exists`);

  if (env().SCRAPE_MODE !== 'live') {
    // No fixture exists for a follower list, and inventing one would put
    // fabricated usernames in front of the user on an Unfollows screen.
    throw new JobPermanentError(
      `SCRAPE_MODE is ${env().SCRAPE_MODE} — a follower snapshot needs a real scrape, and there is no fixture that could stand in for one honestly.`,
    );
  }

  const scraper = getScraper() as ApifyScraper;
  await ctx.save({ progress: 0.05, label: `starting follower scrape for @${account.handle}` });

  const started = await scraper.startFollowers(account.handle, ctx.payload.limit);
  await markWaiting(ctx.jobId, {
    runId: started.runId,
    datasetId: started.datasetId,
    accountId: account.id,
    limit: ctx.payload.limit,
  });
  throw new JobWaiting();
}

interface FollowerItem {
  username?: string;
  ownerUsername?: string;
  handle?: string;
}

/** Pulls usernames out of whatever shape the actor returned. Shared with the webhook. */
export function normalizeFollowerItems(items: unknown[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const row = item as FollowerItem;
    const username = row.username ?? row.ownerUsername ?? row.handle;
    if (typeof username === 'string' && username.trim()) {
      seen.add(username.trim().toLowerCase().replace(/^@/, ''));
    }
  }
  return [...seen];
}

/** Called by the webhook once the run finishes. */
export async function applyFollowerSnapshot(
  accountId: number,
  items: unknown[],
  limit: number,
): Promise<{ count: number; complete: boolean }> {
  const usernames = normalizeFollowerItems(items);
  // Hitting the cap means the list was cut off, not that it ended there.
  const complete = usernames.length < limit;
  await recordSnapshot({
    accountId,
    usernames,
    complete,
    note: complete ? null : `Truncated at the ${limit}-follower limit.`,
  });
  return { count: usernames.length, complete };
}
