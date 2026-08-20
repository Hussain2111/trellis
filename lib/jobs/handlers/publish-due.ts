import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { calendarEntries } from '../../db/schema';
import { env } from '../../env';
import {
  GraphError,
  createContainer,
  publishContainer,
  publishingLimit,
  waitForContainer,
} from '../../publish/graph';
import { claimDueForPublish, getEntry, markScheduleFailed } from '../../publish/schedule';
import { recordRun } from '../../runs/log';
import { JobPermanentError, type JobContext } from '../types';

/**
 * Sweeps due `calendar_entries` rows. Enqueued on a cron tick and
 * opportunistically from the calendar page's poll — the same fire-and-return
 * pattern as every other job here, just with the row's `scheduledFor` doing
 * the "not yet" waiting instead of `JobYield`.
 *
 * v2's primary workflow is copy → paste → post by hand, so
 * `ENABLE_IG_PUBLISHING=false` (the default) is not an error: it means "keep
 * the plan, but nothing goes out on its own". Auto-publish is retained and
 * working for when that flag is flipped.
 */
export async function publishDue(ctx: JobContext<'publish_due'>): Promise<void> {
  const e = env();
  if (!e.ENABLE_IG_PUBLISHING) {
    await ctx.save({
      progress: 1,
      label: 'publishing disabled — calendar entries wait for ENABLE_IG_PUBLISHING=true',
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
      await publishOne(row.id, ctx, igUserId, token);
      usedThisSweep++;
    } catch (error) {
      const permanent = error instanceof GraphError && error.permanent;
      const message = error instanceof Error ? error.message : String(error);
      await markScheduleFailed(row.id, message, permanent);
      await ctx.save({ label: `entry ${row.id} failed: ${message.slice(0, 80)}` });
    }
  }

  await ctx.save({ progress: 1, label: `${due.length} due row(s) handled` });
}

async function publishOne(
  entryId: number,
  ctx: JobContext<'publish_due'>,
  igUserId: string,
  token: string,
): Promise<void> {
  const entry = await getEntry(entryId);
  if (!entry) throw new GraphError(400, `calendar entry ${entryId} no longer exists`);

  const urls = entry.mediaUrls;
  if (urls.length === 0) {
    throw new GraphError(
      400,
      'no media URLs on this entry — auto-publish needs at least one publicly reachable image',
    );
  }

  await db()
    .update(calendarEntries)
    .set({ status: 'publishing' })
    .where(eq(calendarEntries.id, entryId));

  const started = Date.now();
  let mediaId: string;

  if (entry.format === 'carousel' && urls.length > 1) {
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
      caption: entry.caption,
    });
    await waitForContainer(parent, token);
    mediaId = await publishContainer(igUserId, parent, token);
  } else {
    const container = await createContainer({
      igUserId,
      token,
      caption: entry.caption,
      imageUrl: urls[0]!,
    });
    await waitForContainer(container, token, {
      onStatus: (status) => void ctx.save({ label: `container ${status}` }),
    });
    mediaId = await publishContainer(igUserId, container, token);
  }

  await db()
    .update(calendarEntries)
    .set({
      status: 'published',
      igMediaId: mediaId,
      publishedAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(calendarEntries.id, entryId));

  await recordRun({
    provider: 'instagram-graph',
    operation: 'publish',
    status: 'ok',
    costEstimate: 0,
    durationMs: Date.now() - started,
    meta: { entryId, mediaId },
  });
}
