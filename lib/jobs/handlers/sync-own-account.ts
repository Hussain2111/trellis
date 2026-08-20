import { env } from '../../env';
import {
  fetchAccountSnapshot,
  fetchMediaComments,
  fetchMediaInsights,
  fetchOwnMedia,
} from '../../insights/graph';
import {
  applyProfileSnapshot,
  dueCheckpoints,
  graphPostsNeedingInsights,
  recordFollowerDay,
  recordInsights,
  upsertComments,
  upsertGraphMedia,
} from '../../insights/ingest';
import { selfAccount } from '../../ingest/upsert';
import { JobPermanentError, type JobContext } from '../types';

/**
 * The managed account's own data, straight from the Graph API — free, and no
 * Apify credit. Runs daily.
 *
 * Ordered cheapest-first so a run that hits the function's wall clock still
 * banks the important parts: profile and media are one call each, insights
 * and comments are one call per post. `ctx.timeRemainingMs()` stops the
 * per-post loops rather than letting the runner kill the job mid-write —
 * anything skipped is simply picked up by tomorrow's run, or the next tick.
 */
export async function syncOwnAccount(ctx: JobContext<'sync_own_account'>): Promise<void> {
  const e = env();
  const self = await selfAccount();
  if (!self) throw new JobPermanentError('no self account configured yet');
  if (!e.IG_USER_ID || !e.IG_ACCESS_TOKEN) {
    throw new JobPermanentError(
      "IG_USER_ID / IG_ACCESS_TOKEN are not set — the account's own data comes from the Graph API now. See docs/instagram-setup.md.",
    );
  }
  const igUserId = e.IG_USER_ID;
  const token = e.IG_ACCESS_TOKEN;

  await ctx.save({ progress: 0.1, label: 'fetching profile' });
  const snapshot = await fetchAccountSnapshot({ igUserId, token });
  await applyProfileSnapshot(self.id, snapshot);
  await recordFollowerDay(snapshot);

  await ctx.save({ progress: 0.25, label: 'fetching own media' });
  const { media } = await fetchOwnMedia({
    igUserId,
    token,
    limit: ctx.payload.mediaLimit,
  });
  const summary = await upsertGraphMedia(self.id, media);

  await ctx.save({
    progress: 0.4,
    label: `${summary.inserted} new, ${summary.updated} refreshed`,
  });

  // Insights: every post gets `latest` refreshed, and any fixed checkpoint it
  // has newly passed gets written once.
  const candidates = await graphPostsNeedingInsights(self.id, ctx.payload.insightLimit);
  let captured = 0;
  let skippedForTime = 0;

  for (const post of candidates) {
    if (ctx.timeRemainingMs() < 4_000) {
      skippedForTime = candidates.length - captured;
      break;
    }
    if (!post.igMediaId) continue;

    const insights = await fetchMediaInsights({
      mediaId: post.igMediaId,
      token,
      mediaType: post.type,
    });
    await recordInsights(post.id, 'latest', insights);
    for (const checkpoint of dueCheckpoints(post.takenAt, post.captured)) {
      await recordInsights(post.id, checkpoint, insights);
    }
    captured++;
    if (captured % 5 === 0) {
      await ctx.save({ progress: 0.4 + 0.4 * (captured / candidates.length) });
    }
  }

  await ctx.save({ progress: 0.85, label: `${captured} post(s) measured` });

  // Comments, newest posts first — Most Active Followers aggregates over these.
  let commentsAdded = 0;
  for (const post of candidates.slice(0, ctx.payload.commentLimit)) {
    if (ctx.timeRemainingMs() < 4_000) break;
    if (!post.igMediaId) continue;
    const comments = await fetchMediaComments({ mediaId: post.igMediaId, token });
    const result = await upsertComments(post.id, comments);
    commentsAdded += result.inserted;
  }

  await ctx.save({
    progress: 1,
    label:
      `${summary.inserted} new post(s), ${captured} measured, ${commentsAdded} new comment(s)` +
      (skippedForTime > 0 ? ` — ${skippedForTime} left for the next run` : ''),
    checkpoint: {
      followers: snapshot.followers,
      inserted: summary.inserted,
      captured,
      commentsAdded,
      followsUnfollowsAvailable: snapshot.unavailableReason === null,
    },
  });
}
