import { env } from '../../env';
import { getScraper } from '../../providers';
import { ApifyScraper } from '../../providers/scraper/apify';
import type { ScrapedPost, ScrapedProfile } from '../../providers/scraper/types';
import {
  getAccount,
  knownShortcodes,
  markScanned,
  updateAccountProfile,
  upsertPosts,
} from '../../ingest/upsert';
import { enqueue, markWaiting } from '../queue';
import { JobPermanentError, JobWaiting, type JobContext } from '../types';

/**
 * Scan one **competitor** account through Apify. Incremental by default: the
 * scraper is told which shortcodes we already hold and stops at the first one
 * it recognises, so a re-scan fetches the few new posts rather than re-pulling
 * a hundred.
 *
 * The managed account is deliberately not scrapable here. Its own posts,
 * insights and comments come from the Graph API for free (`sync_own_account`),
 * so spending Apify credit on data Meta hands over is pure waste — and the two
 * paths disagree about what a "view" is, which would make the numbers
 * incomparable.
 *
 * In fixture/fake mode this completes synchronously (it's instant — no real
 * network call). In live mode it fires the Apify actor and returns; the
 * `/api/webhooks/apify` route finishes the job once Apify reports it done.
 */
export async function scanAccount(ctx: JobContext<'scan_account'>): Promise<void> {
  const account = await getAccount(ctx.payload.accountId);
  if (!account) throw new JobPermanentError(`account ${ctx.payload.accountId} no longer exists`);
  if (account.role === 'self') {
    throw new JobPermanentError(
      `@${account.handle} is the managed account — its data comes from the Graph API (sync_own_account), not Apify.`,
    );
  }

  const stopAt = await knownShortcodes(account.id);

  if (env().SCRAPE_MODE === 'live') {
    const scraper = getScraper() as ApifyScraper;
    await ctx.save({ progress: 0.05, label: `starting Apify actor for @${account.handle}` });
    const started = await scraper.start({ handle: account.handle, limit: ctx.payload.limit });
    await markWaiting(ctx.jobId, {
      runId: started.runId,
      datasetId: started.datasetId,
      limit: ctx.payload.limit,
      stopAt: [...stopAt],
    });
    throw new JobWaiting();
  }

  const scraper = getScraper();
  await ctx.save({ progress: 0.2, label: `scanning @${account.handle}` });
  const result = await scraper.scrape({
    handle: account.handle,
    limit: ctx.payload.limit,
    stopAtShortcodes: stopAt,
  });

  await applyScanResult(
    account.id,
    result.profile,
    result.posts,
    result.complete,
    result.note,
    ctx,
  );
}

/** Shared by the synchronous (fixture/fake) path and the Apify webhook. */
export async function applyScanResult(
  accountId: number,
  profile: ScrapedProfile | null,
  posts: ScrapedPost[],
  complete: boolean,
  note: string,
  ctx?: JobContext,
): Promise<{ inserted: number; updated: number; total: number }> {
  await ctx?.save({ progress: 0.8, label: `storing ${posts.length} posts` });

  if (profile) await updateAccountProfile(accountId, profile);
  const summary = await upsertPosts(accountId, posts);
  await markScanned(accountId);

  await ctx?.save({
    progress: 1,
    label: `${summary.inserted} new, ${summary.updated} refreshed${complete ? '' : ' (PARTIAL)'}`,
    checkpoint: { ...summary, complete, note },
  });

  // Features are cheap, deterministic and always wanted after a scan.
  await enqueue('compute_features', { accountId }, { dedupe: false });

  // Discovery deliberately does NOT chain off a scan any more. It is the
  // expensive Apify path, so it runs on the weekly cron instead of once per
  // scan — see lib/jobs/handlers/weekly-niche.ts.

  return summary;
}
