import fs from 'node:fs';
import path from 'node:path';
import { and, eq, lte, sql } from 'drizzle-orm';
import { db, sqlite } from '../../db/client';
import { draftAssets, drafts, schedule } from '../../db/schema';
import { env } from '../../env';
import { getSettings } from '../../settings';
import { selfAccount } from '../../ingest/upsert';
import { notify } from '../../publish/notify';
import {
  createContainer,
  inspectToken,
  publishContainer,
  publishingLimit,
  waitForContainer,
  GraphError,
} from '../../publish/graph';
import { openQuickTunnel } from '../../publish/tunnel';
import { recordRun } from '../../runs/log';
import type { JobContext } from '../types';

const nowS = (): number => Math.floor(Date.now() / 1000);

/**
 * Sweep due schedule rows. Runs every minute from cron.
 *
 * Rows are claimed with an atomic status transition so a second worker (or a
 * restarted one) can never publish the same post twice.
 */
export async function publishDue(ctx: JobContext<'publish_due'>): Promise<void> {
  const settings = getSettings();
  const due = claimDue(settings.publishingMode);

  if (due.length === 0) {
    ctx.save({ progress: 1, label: 'nothing due' });
    return;
  }

  for (const row of due) {
    const draft = db().select().from(drafts).where(eq(drafts.id, row.draftId)).get();
    if (!draft) {
      markFailed(row.id, 'draft no longer exists', true);
      continue;
    }

    if (settings.publishingMode === 'manual') {
      notify(
        `Ready to post: ${draft.title}`,
        `${draft.format} · open Trellis to copy the caption and grab the assets.`,
      );
      db()
        .update(schedule)
        .set({ status: 'pending', notifiedAt: nowS() })
        .where(eq(schedule.id, row.id))
        .run();
      ctx.save({ label: `notified for draft ${draft.id}` });
      continue;
    }

    try {
      await publishViaGraph(row.id, draft.id, ctx);
    } catch (error) {
      const permanent = error instanceof GraphError && error.permanent;
      markFailed(row.id, (error as Error).message, permanent);
      ctx.save({ label: `draft ${draft.id} failed: ${(error as Error).message.slice(0, 80)}` });
    }
  }

  ctx.save({ progress: 1, label: `${due.length} row(s) handled` });
}

/**
 * Atomic claim: one UPDATE moves pending → claimed and returns the rows, so two
 * processes cannot both pick up the same scheduled post.
 */
function claimDue(mode: 'manual' | 'api'): { id: number; draftId: number; attempts: number }[] {
  const raw = sqlite();
  const rows = raw
    .prepare(
      `UPDATE schedule
          SET status = 'claimed'
        WHERE id IN (
          SELECT id FROM schedule
           WHERE status = 'pending'
             AND scheduled_for <= ?
             AND attempts < 3
             AND (? = 'manual' OR notified_at IS NULL OR 1 = 1)
           ORDER BY scheduled_for ASC
           LIMIT 5
        )
       RETURNING id, draft_id as draftId, attempts`,
    )
    .all(nowS(), mode) as { id: number; draftId: number; attempts: number }[];

  // In manual mode a row that has already been notified stays put until the
  // user marks it posted — re-notifying every minute would be intolerable.
  if (mode === 'manual') {
    const filtered: typeof rows = [];
    for (const row of rows) {
      const current = db().select().from(schedule).where(eq(schedule.id, row.id)).get();
      if (current?.notifiedAt) {
        db().update(schedule).set({ status: 'pending' }).where(eq(schedule.id, row.id)).run();
        continue;
      }
      filtered.push(row);
    }
    return filtered;
  }
  return rows;
}

function markFailed(scheduleId: number, error: string, permanent: boolean): void {
  const row = db().select().from(schedule).where(eq(schedule.id, scheduleId)).get();
  const attempts = (row?.attempts ?? 0) + 1;
  db()
    .update(schedule)
    .set({
      status: permanent || attempts >= 3 ? 'failed' : 'pending',
      attempts,
      lastError: error,
      // Exponential backoff between attempts.
      scheduledFor: permanent ? (row?.scheduledFor ?? nowS()) : nowS() + 2 ** attempts * 60,
    })
    .where(eq(schedule.id, scheduleId))
    .run();
}

async function publishViaGraph(
  scheduleId: number,
  draftId: number,
  ctx: JobContext<'publish_due'>,
): Promise<void> {
  const e = env();
  const settings = getSettings();

  if (!e.ENABLE_IG_PUBLISHING) {
    throw new Error('ENABLE_IG_PUBLISHING is false — refusing to publish.');
  }
  if (!e.IG_USER_ID || !e.IG_ACCESS_TOKEN) {
    throw new Error('IG_USER_ID / IG_ACCESS_TOKEN are not set. See docs/instagram-setup.md.');
  }

  const limit = await publishingLimit(e.IG_USER_ID, e.IG_ACCESS_TOKEN);
  const cap = limit?.cap ?? settings.publishCapPer24h;
  if (limit && limit.used >= cap) {
    throw new Error(`Publishing cap reached (${limit.used}/${cap} in the last 24h).`);
  }

  const draft = db().select().from(drafts).where(eq(drafts.id, draftId)).get()!;
  const assets = db().select().from(draftAssets).where(eq(draftAssets.draftId, draftId)).all();
  const files = assets
    .map((a) => a.localPath)
    .filter((p): p is string => !!p && fs.existsSync(p))
    .sort();

  if (files.length === 0) {
    throw new GraphError(400, 'no rendered assets — render the slides before publishing');
  }

  db().update(schedule).set({ status: 'publishing' }).where(eq(schedule.id, scheduleId)).run();

  // Resolved at publish time, never stored: quick-tunnel URLs are ephemeral.
  ctx.save({ label: 'opening media tunnel' });
  const base = await openQuickTunnel(Number(process.env.PORT ?? 3000));
  const publicUrls = files.map(
    (file) => `${base}/api/assets/${draftId}/${encodeURIComponent(path.basename(file))}`,
  );

  const started = Date.now();
  let mediaId: string;

  if (draft.format === 'carousel' && publicUrls.length > 1) {
    const children: string[] = [];
    for (const url of publicUrls) {
      const child = await createContainer({
        igUserId: e.IG_USER_ID,
        token: e.IG_ACCESS_TOKEN,
        imageUrl: url,
        isCarouselItem: true,
      });
      await waitForContainer(child, e.IG_ACCESS_TOKEN);
      children.push(child);
      ctx.save({ label: `carousel child ${children.length}/${publicUrls.length}` });
    }
    const parent = await createContainer({
      igUserId: e.IG_USER_ID,
      token: e.IG_ACCESS_TOKEN,
      mediaType: 'CAROUSEL',
      children,
      caption: draft.caption,
    });
    await waitForContainer(parent, e.IG_ACCESS_TOKEN);
    mediaId = await publishContainer(e.IG_USER_ID, parent, e.IG_ACCESS_TOKEN);
  } else {
    const isVideo = /\.mp4$/i.test(files[0]!);
    const container = await createContainer({
      igUserId: e.IG_USER_ID,
      token: e.IG_ACCESS_TOKEN,
      caption: draft.caption,
      ...(isVideo
        ? { videoUrl: publicUrls[0]!, mediaType: 'REELS' as const }
        : { imageUrl: publicUrls[0]! }),
    });
    await waitForContainer(container, e.IG_ACCESS_TOKEN, {
      onStatus: (status) => ctx.save({ label: `container ${status}` }),
    });
    mediaId = await publishContainer(e.IG_USER_ID, container, e.IG_ACCESS_TOKEN);
  }

  db()
    .update(schedule)
    .set({ status: 'published', igMediaId: mediaId, publishedAt: nowS(), lastError: null })
    .where(eq(schedule.id, scheduleId))
    .run();
  db().update(drafts).set({ status: 'published' }).where(eq(drafts.id, draftId)).run();

  recordRun({
    provider: 'instagram-graph',
    operation: 'publish',
    status: 'ok',
    costEstimate: 0,
    durationMs: Date.now() - started,
    meta: { draftId, mediaId },
  });

  notify('Published', `${draft.title} is live.`);
}

/**
 * Long-lived tokens expire in ~60 days. Refresh well ahead of that and warn
 * loudly at 7 days, because a silently expired token looks like "publishing
 * broke" a week later.
 */
export async function refreshIgToken(ctx: JobContext<'refresh_ig_token'>): Promise<void> {
  const e = env();
  if (!e.ENABLE_IG_PUBLISHING || !e.IG_ACCESS_TOKEN) {
    ctx.save({ progress: 1, label: 'publishing disabled — nothing to refresh' });
    return;
  }

  const info = await inspectToken(e.IG_ACCESS_TOKEN);
  if (!info.valid) {
    notify('Instagram token invalid', 'Re-authorise in docs/instagram-setup.md.');
    ctx.save({ progress: 1, label: `token invalid: ${info.detail}` });
    return;
  }

  if (info.daysRemaining !== null && info.daysRemaining <= 7) {
    notify(
      'Instagram token expiring',
      `${info.daysRemaining} day(s) left. Refresh it before publishing stops.`,
    );
  }

  ctx.save({ progress: 1, label: `token ${info.detail}` });
}

/** Schedule a draft. Used by the calendar UI and the chat tool. */
export function scheduleDraft(draftId: number, scheduledFor: number, mode: 'manual' | 'api'): number {
  const row = db()
    .insert(schedule)
    .values({ draftId, scheduledFor, status: 'pending', mode })
    .returning({ id: schedule.id })
    .get();
  db().update(drafts).set({ status: 'scheduled' }).where(eq(drafts.id, draftId)).run();
  return row.id;
}

export function unschedule(scheduleId: number): void {
  const row = db().select().from(schedule).where(eq(schedule.id, scheduleId)).get();
  if (!row) return;
  db().delete(schedule).where(eq(schedule.id, scheduleId)).run();
  db().update(drafts).set({ status: 'draft' }).where(eq(drafts.id, row.draftId)).run();
}

export function markPosted(scheduleId: number): void {
  const row = db().select().from(schedule).where(eq(schedule.id, scheduleId)).get();
  if (!row) return;
  db()
    .update(schedule)
    .set({ status: 'published', publishedAt: nowS() })
    .where(eq(schedule.id, scheduleId))
    .run();
  db().update(drafts).set({ status: 'published' }).where(eq(drafts.id, row.draftId)).run();
}

export function scheduledRows() {
  return db()
    .select({ schedule, draft: drafts })
    .from(schedule)
    .innerJoin(drafts, eq(drafts.id, schedule.draftId))
    .orderBy(schedule.scheduledFor)
    .all();
}

export function dueNow() {
  return db()
    .select({ schedule, draft: drafts })
    .from(schedule)
    .innerJoin(drafts, eq(drafts.id, schedule.draftId))
    .where(and(eq(schedule.status, 'pending'), lte(schedule.scheduledFor, nowS())))
    .orderBy(sql`${schedule.scheduledFor} asc`)
    .all();
}
