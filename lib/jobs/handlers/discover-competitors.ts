import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { posts } from '../../db/schema';
import { topHashtags } from '../../analysis/hashtags';
import { rankAccountsByEngagement, type HashtagPost } from '../../analysis/hashtags';
import { inferAndStoreNiche } from '../../analysis/niche';
import { getAccount, listAccounts, upsertAccount } from '../../ingest/upsert';
import { enqueue, getJob } from '../queue';
import { JobPermanentError, JobYield, type JobContext } from '../types';

interface Checkpoint {
  hashtags: string[];
  hashtagJobIds: number[];
}

/**
 * Automatic competitor/niche discovery, chained onto a self-account scan:
 * infer the niche (one model call), pull the account's most-used hashtags
 * (deterministic), scan each hashtag to see who dominates it by engagement,
 * then scan the top accounts found there as competitors.
 *
 * Waits for its `scan_hashtag` children by yielding (JobYield) rather than
 * blocking — each child may itself be a fire-and-webhook Apify run in live
 * mode, which can take far longer than one function invocation.
 */
export async function discoverCompetitors(ctx: JobContext<'discover_competitors'>): Promise<void> {
  const account = await getAccount(ctx.payload.accountId);
  if (!account) throw new JobPermanentError(`account ${ctx.payload.accountId} no longer exists`);

  const checkpoint = ctx.checkpoint as Checkpoint | null;

  if (!checkpoint) {
    const ownPosts = await db()
      .select({ caption: posts.caption })
      .from(posts)
      .where(eq(posts.accountId, account.id));
    const hashtags = topHashtags(ownPosts, 5);

    await inferAndStoreNiche(account);

    if (hashtags.length === 0) {
      await ctx.save({
        progress: 1,
        label: 'no hashtags to discover from',
        checkpoint: { hashtags: [], hashtagJobIds: [] },
      });
      return;
    }

    const hashtagJobIds: number[] = [];
    for (const hashtag of hashtags) {
      const id = await enqueue('scan_hashtag', { hashtag, limit: 30 }, { priority: 10 });
      if (id !== null) hashtagJobIds.push(id);
    }

    await ctx.save({
      progress: 0.2,
      label: `scanning ${hashtags.length} hashtags`,
      checkpoint: { hashtags, hashtagJobIds } satisfies Checkpoint,
    });
    // Priority ordering (children=10, this job=0) puts every child ahead of
    // this job's next attempt, so a zero delay is safe — it just means "as
    // soon as there's nothing higher-priority left to run".
    throw new JobYield('waiting on hashtag scans', 0);
  }

  const childJobs = await Promise.all(checkpoint.hashtagJobIds.map((id) => getJob(id)));
  const pending = childJobs.filter((j) => j && j.status !== 'done' && j.status !== 'failed');
  if (pending.length > 0) {
    throw new JobYield(`waiting on ${pending.length} hashtag scan(s)`, 3);
  }

  const byHashtag: { hashtag: string; posts: HashtagPost[] }[] = [];
  for (const job of childJobs) {
    if (!job || job.status !== 'done') continue;
    const jobCheckpoint = job.checkpoint as { hashtag: string; results: HashtagPost[] } | null;
    if (jobCheckpoint)
      byHashtag.push({ hashtag: jobCheckpoint.hashtag, posts: jobCheckpoint.results });
  }

  const known = await listAccounts();
  const excludeHandles = new Set(known.map((a) => a.handle));
  const ranked = rankAccountsByEngagement(byHashtag, excludeHandles, 6);

  const competitorIds: number[] = [];
  for (const candidate of ranked) {
    const competitor = await upsertAccount({
      handle: candidate.handle,
      role: 'competitor',
      discoveredViaHashtag: candidate.hashtags[0],
    });
    competitorIds.push(competitor.id);
    await enqueue('scan_account', { accountId: competitor.id, limit: 20 }, { dedupe: true });
  }

  await ctx.save({
    progress: 1,
    label: `discovered ${ranked.length} competitor(s)`,
    checkpoint: { ...checkpoint, competitors: ranked.map((r) => r.handle) },
  });
}
