import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { calendarEntries, type CalendarEntry, type NewCalendarEntry } from '../db/schema';
import { isDue, isOverdue } from '../time';

/**
 * CRUD + the atomic claim over `calendar_entries`. v1 kept content in `drafts`
 * and timing in `schedule`; v2 has no draft generation, so an entry is
 * something the user typed and owns its own content. The claim is the one
 * operation that has to be safe under concurrent job ticks, so it keeps the
 * same `FOR UPDATE SKIP LOCKED` pattern as `lib/jobs/queue.ts`'s `claimNext`.
 */

export type EntryState = 'planned' | 'due' | 'overdue' | 'published' | 'failed' | 'publishing';

/**
 * `due` and `overdue` are derived here rather than stored — a stored `due`
 * would go stale the moment the clock passed it with nothing running.
 */
export function entryState(entry: CalendarEntry, now: Date = new Date()): EntryState {
  if (entry.status === 'published') return 'published';
  if (entry.status === 'failed') return 'failed';
  if (entry.status === 'claimed' || entry.status === 'publishing') return 'publishing';
  if (isOverdue(entry.scheduledFor, now)) return 'overdue';
  if (isDue(entry.scheduledFor, now)) return 'due';
  return 'planned';
}

export async function createEntry(values: NewCalendarEntry): Promise<number> {
  const [row] = await db().insert(calendarEntries).values(values).returning({
    id: calendarEntries.id,
  });
  return row!.id;
}

export async function updateEntry(id: number, values: Partial<NewCalendarEntry>): Promise<void> {
  await db()
    .update(calendarEntries)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(calendarEntries.id, id));
}

export async function deleteEntry(id: number): Promise<void> {
  await db().delete(calendarEntries).where(eq(calendarEntries.id, id));
}

/** For when ENABLE_IG_PUBLISHING is off and the user posted it by hand. */
export async function markPosted(id: number): Promise<void> {
  await db()
    .update(calendarEntries)
    .set({ status: 'published', publishedAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(eq(calendarEntries.id, id));
}

export async function listEntries(): Promise<CalendarEntry[]> {
  return db().select().from(calendarEntries).orderBy(asc(calendarEntries.scheduledFor));
}

export async function getEntry(id: number): Promise<CalendarEntry | null> {
  const [row] = await db()
    .select()
    .from(calendarEntries)
    .where(eq(calendarEntries.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Atomically move due, unclaimed rows to `claimed` and return them — so two
 * overlapping job ticks (a cron sweep landing mid-poll from an open calendar
 * tab, say) can never both try to publish the same row.
 */
export async function claimDueForPublish(limit = 5): Promise<{ id: number; attempts: number }[]> {
  return db().execute<{ id: number; attempts: number }>(sql`
    UPDATE calendar_entries
       SET status = 'claimed'
     WHERE id IN (
       SELECT id FROM calendar_entries
        WHERE status = 'planned'
          AND scheduled_for <= now()
          AND attempts < 3
        ORDER BY scheduled_for ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, attempts
  `);
}

/** Exponential backoff between publish attempts, same shape as the job queue's. */
export async function markScheduleFailed(
  id: number,
  error: string,
  permanent: boolean,
): Promise<void> {
  const entry = await getEntry(id);
  const attempts = (entry?.attempts ?? 0) + 1;
  const failed = permanent || attempts >= 3;
  await db()
    .update(calendarEntries)
    .set({
      status: failed ? 'failed' : 'planned',
      attempts,
      lastError: error,
      updatedAt: new Date(),
      scheduledFor: failed
        ? (entry?.scheduledFor ?? new Date())
        : new Date(Date.now() + 2 ** attempts * 60_000),
    })
    .where(eq(calendarEntries.id, id));
}
