import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { draftAssets, drafts, schedule } from '../../db/schema';
import { env } from '../../env';
import {
  GraphError,
  createContainer,
  publishContainer,
  publishingLimit,
  waitForContainer,
} from '../../publish/graph';
import { claimDueForPublish, markScheduleFailed } from '../../publish/schedule';
import { recordRun } from '../../runs/log';
import { JobPermanentError, type JobContext } from '../types';

/**
 * Sweeps due `schedule` rows. Enqueued on a cron tick (daily, per Vercel
 * Hobby's cron minimum) and opportunistically from the calendar page's poll
 * — the same fire-and-return pattern as every other job here, just with the
 * queue's `runAfter` field doing the "not yet" waiting instead of `JobYield`.
 *
 * `ENABLE_IG_PUBLISHING=false` (the default) is not an error: it means "keep
 * the schedule, but nothing goes out on its own" — the spec's own framing
 * of the first real publish as a manual, watched event. This is that guard's
 * enforcement point.
 */
export async function publishDue(ctx: JobContext<'publish_due'>): Promise<void> {
  const e = env();
  if (!e.ENABLE_IG_PUBLISHING) {
    await ctx.save({
      progress: 1,
      label: 'publishing disabled — scheduled drafts wait for ENABLE_IG_PUBLISHING=true',
    });
    return;
  }
  if (!e.IG_USER_ID || !e.IG_ACCESS_TOKEN) {
    throw new JobPermanentError(
      'ENABLE_IG_PUBLISHING is true but IG_USER_ID / IG_ACCESS_TOKEN are not set. See docs/instagram-setup.md.',
    );
  }
  const igUserId = e.IG_USER_ID;
  const token = e.IG_ACCESS_TOKEN;

  const due = await claimDueForPublish();
  if (due.length === 0) {
    await ctx.save({ progress: 1, label: 'nothing due' });
    return;
  }

  const limit = await publishingLimit(igUserId, token);
  const cap = limit?.cap ?? 25;
  let usedThisSweep = limit?.used ?? 0;

  for (const row of due) {
    if (usedThisSweep >= cap) {
      await markScheduleFailed(
        row.id,
        `Publishing cap reached (${usedThisSweep}/${cap} in the last 24h).`,
        false,
      );
      continue;
    }
    try {
      await publishOne(row.id, row.draftId, ctx, igUserId, token);
      usedThisSweep++;
    } catch (error) {
      const permanent = error instanceof GraphError && error.permanent;
      const message = error instanceof Error ? error.message : String(error);
      await markScheduleFailed(row.id, message, permanent);
      await ctx.save({ label: `draft ${row.draftId} failed: ${message.slice(0, 80)}` });
    }
  }

  await ctx.save({ progress: 1, label: `${due.length} due row(s) handled` });
}

async function publishOne(
  scheduleId: number,
  draftId: number,
  ctx: JobContext<'publish_due'>,
  igUserId: string,
  token: string,
): Promise<void> {
  const [draft] = await db().select().from(drafts).where(eq(drafts.id, draftId)).limit(1);
  if (!draft) throw new GraphError(400, `draft ${draftId} no longer exists`);

  const assets = await db().select().from(draftAssets).where(eq(draftAssets.draftId, draftId));
  const urls = assets
    .filter((a) => a.kind === 'slide' && a.publicUrl)
    .sort((a, b) => (a.slideIndex ?? 0) - (b.slideIndex ?? 0))
    .map((a) => a.publicUrl!);

  if (urls.length === 0) {
    throw new GraphError(400, 'no rendered assets — render the slides before publishing');
  }

  await db().update(schedule).set({ status: 'publishing' }).where(eq(schedule.id, scheduleId));

  const started = Date.now();
  let mediaId: string;

  if (draft.format === 'carousel' && urls.length > 1) {
    const children: string[] = [];
    for (const url of urls) {
      const child = await createContainer({ igUserId, token, imageUrl: url, isCarouselItem: true });
      await waitForContainer(child, token);
      children.push(child);
      await ctx.save({ label: `carousel child ${children.length}/${urls.length}` });
    }
    const parent = await createContainer({
      igUserId,
      token,
      mediaType: 'CAROUSEL',
      children,
      caption: draft.caption,
    });
    await waitForContainer(parent, token);
    mediaId = await publishContainer(igUserId, parent, token);
  } else {
    const container = await createContainer({
      igUserId,
      token,
      caption: draft.caption,
      imageUrl: urls[0]!,
    });
    await waitForContainer(container, token, {
      onStatus: (status) => void ctx.save({ label: `container ${status}` }),
    });
    mediaId = await publishContainer(igUserId, container, token);
  }

  await db()
    .update(schedule)
    .set({ status: 'published', igMediaId: mediaId, publishedAt: new Date(), lastError: null })
    .where(eq(schedule.id, scheduleId));
  await db().update(drafts).set({ status: 'published' }).where(eq(drafts.id, draftId));

  await recordRun({
    provider: 'instagram-graph',
    operation: 'publish',
    status: 'ok',
    costEstimate: 0,
    durationMs: Date.now() - started,
    meta: { draftId, mediaId },
  });
}
