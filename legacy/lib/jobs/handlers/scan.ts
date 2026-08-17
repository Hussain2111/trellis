import { env } from '../../env';
import { getScraper } from '../../providers';
import { writeFixture } from '../../providers/scraper/apify';
import {
  getAccount,
  knownShortcodes,
  markScanned,
  updateAccountProfile,
  upsertPosts,
} from '../../ingest/upsert';
import { enqueue } from '../queue';
import { JobPermanentError, type JobContext } from '../types';

/**
 * Scan one account. Incremental by default: the scraper is told which
 * shortcodes we already hold and stops at the first one it recognises, so a
 * re-scan fetches the four new posts rather than re-pulling a hundred.
 */
export async function scanAccount(ctx: JobContext<'scan_account'>): Promise<void> {
  const account = getAccount(ctx.payload.accountId);
  if (!account) throw new JobPermanentError(`account ${ctx.payload.accountId} no longer exists`);

  const scraper = getScraper();
  ctx.save({ progress: 0.05, label: `scanning @${account.handle}` });

  const stopAt = ctx.payload.incremental ? knownShortcodes(account.id) : new Set<string>();

  const result = await scraper.scrape({
    handle: account.handle,
    limit: ctx.payload.limit,
    stopAtShortcodes: stopAt,
    onProgress: (seen, label) => {
      ctx.save({ progress: Math.min(0.7, 0.05 + seen / (ctx.payload.limit * 2)), label });
    },
  });

  // Save the first live response so every later iteration can run offline.
  if (env().SCRAPE_MODE === 'live' && result.complete && result.posts.length > 0) {
    const file = writeFixture(account.handle, result.raw);
    ctx.save({ label: `fixture saved → ${file}` });
  }

  ctx.save({ progress: 0.8, label: `storing ${result.posts.length} posts` });

  if (result.profile) updateAccountProfile(account.id, result.profile);
  const summary = upsertPosts(account.id, result.posts);
  markScanned(account.id);

  ctx.save({
    progress: 1,
    label: `${summary.inserted} new, ${summary.updated} refreshed${result.complete ? '' : ' (PARTIAL)'}`,
    checkpoint: { ...summary, complete: result.complete, note: result.note },
  });

  // Features are cheap, deterministic and always wanted after a scan.
  enqueue('compute_features', { accountId: account.id }, { dedupe: false });
}
