import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { drafts, schedule } from '../db/schema';

/**
 * CRUD + the atomic claim over the `schedule` table. Scheduling a draft is a
 * plain insert triggered from the UI; the claim is the one operation that
 * has to be safe under concurrent job ticks, so it uses the same
 * `FOR UPDATE SKIP LOCKED` pattern as `lib/jobs/queue.ts`'s `claimNext`.
 */

export async function scheduleDraft(draftId: number, scheduledFor: Date): Promise<number> {
  const [row] = await db()
    .insert(schedule)
    .values({ draftId, scheduledFor, status: 'pending' })
    .returning({ id: schedule.id });
  await db().update(drafts).set({ status: 'scheduled' }).where(eq(drafts.id, draftId));
  return row!.id;
}

export async function unschedule(scheduleId: number): Promise<void> {
  const [row] = await db().select().from(schedule).where(eq(schedule.id, scheduleId)).limit(1);
  if (!row) return;
  await db().delete(schedule).where(eq(schedule.id, scheduleId));
  await db().update(drafts).set({ status: 'draft' }).where(eq(drafts.id, row.draftId));
}

/** For when ENABLE_IG_PUBLISHING is off and the user posted it by hand. */
export async function markPosted(scheduleId: number): Promise<void> {
  const [row] = await db().select().from(schedule).where(eq(schedule.id, scheduleId)).limit(1);
  if (!row) return;
  await db()
    .update(schedule)
    .set({ status: 'published', publishedAt: new Date(), lastError: null })
    .where(eq(schedule.id, scheduleId));
  await db().update(drafts).set({ status: 'published' }).where(eq(drafts.id, row.draftId));
}

export async function scheduledRows() {
  return db()
    .select({ schedule, draft: drafts })
    .from(schedule)
    .innerJoin(drafts, eq(drafts.id, schedule.draftId))
    .orderBy(asc(schedule.scheduledFor));
}

/**
 * Atomically move due, unclaimed rows to `claimed` and return them — so two
 * overlapping job ticks (a cron sweep landing mid-poll from an open
 * calendar tab, say) can never both try to publish the same row.
 */
export async function claimDueForPublish(
  limit = 5,
): Promise<{ id: number; draftId: number; attempts: number }[]> {
  const rows = await db().execute<{ id: number; draftId: number; attempts: number }>(sql`
    UPDATE schedule
       SET status = 'claimed'
     WHERE id IN (
       SELECT id FROM schedule
        WHERE status = 'pending'
          AND scheduled_for <= now()
          AND attempts < 3
        ORDER BY scheduled_for ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, draft_id AS "draftId", attempts
  `);
  return rows;
}

/** Exponential backoff between publish attempts, same shape as the job queue's. */
export async function markScheduleFailed(
  scheduleId: number,
  error: string,
  permanent: boolean,
): Promise<void> {
  const [row] = await db().select().from(schedule).where(eq(schedule.id, scheduleId)).limit(1);
  const attempts = (row?.attempts ?? 0) + 1;
  const failed = permanent || attempts >= 3;
  await db()
    .update(schedule)
    .set({
      status: failed ? 'failed' : 'pending',
      attempts,
      lastError: error,
      scheduledFor: failed
        ? (row?.scheduledFor ?? new Date())
        : new Date(Date.now() + 2 ** attempts * 60_000),
    })
    .where(eq(schedule.id, scheduleId));
}
