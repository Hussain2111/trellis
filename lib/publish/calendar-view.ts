import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client';
import { calendarEntries, postInsights, posts, type CalendarEntry } from '../db/schema';
import { formatRiyadh, riyadhDay, startOfWeekRiyadh } from '../time';
import { entryState, listEntries, type EntryState } from './schedule';

/**
 * Shapes calendar rows for display: what needs attention now, and everything
 * else grouped into Riyadh weeks.
 *
 * Weeks are Monday-based and computed in Riyadh local time, which is why this
 * cannot be a plain `ORDER BY scheduled_for` in SQL — an entry at 01:00 Riyadh
 * on a Monday is 22:00 UTC on the Sunday, and would land in the wrong week.
 */

export interface CalendarRow {
  entry: CalendarEntry;
  state: EntryState;
  /** How the post it became actually performed, once it exists. */
  outcome: { reach: number | null; totalInteractions: number | null } | null;
}

export interface CalendarWeek {
  /** Monday, as a Riyadh `YYYY-MM-DD`. */
  weekStart: string;
  label: string;
  rows: CalendarRow[];
}

export interface CalendarView {
  /** Due or overdue and not yet posted — the only rows that need a decision today. */
  needsAttention: CalendarRow[];
  weeks: CalendarWeek[];
  counts: Record<EntryState, number>;
}

export async function calendarView(now: Date = new Date()): Promise<CalendarView> {
  const entries = await listEntries();
  const outcomes = await publishedOutcomes();

  const rows: CalendarRow[] = entries.map((entry) => ({
    entry,
    state: entryState(entry, now),
    outcome: entry.igMediaId ? (outcomes.get(entry.igMediaId) ?? null) : null,
  }));

  const counts = rows.reduce(
    (acc, row) => {
      acc[row.state] = (acc[row.state] ?? 0) + 1;
      return acc;
    },
    {} as Record<EntryState, number>,
  );

  const byWeek = new Map<string, CalendarRow[]>();
  for (const row of rows) {
    const key = riyadhDay(startOfWeekRiyadh(row.entry.scheduledFor));
    const list = byWeek.get(key) ?? [];
    list.push(row);
    byWeek.set(key, list);
  }

  const thisWeek = riyadhDay(startOfWeekRiyadh(now));

  const weeks: CalendarWeek[] = [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStart, weekRows]) => ({
      weekStart,
      label: weekLabel(weekStart, thisWeek),
      rows: weekRows.sort(
        (a, b) => a.entry.scheduledFor.getTime() - b.entry.scheduledFor.getTime(),
      ),
    }));

  return {
    needsAttention: rows
      .filter((r) => r.state === 'due' || r.state === 'overdue')
      .sort((a, b) => a.entry.scheduledFor.getTime() - b.entry.scheduledFor.getTime()),
    weeks,
    counts,
  };
}

function weekLabel(weekStart: string, thisWeek: string): string {
  if (weekStart === thisWeek) return 'This week';
  const start = new Date(`${weekStart}T00:00:00+03:00`);
  const next = new Date(Date.parse(`${thisWeek}T00:00:00+03:00`) + 7 * 86_400_000);
  if (weekStart === riyadhDay(next)) return 'Next week';
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return `${formatRiyadh(start, { day: 'numeric', month: 'short' })} – ${formatRiyadh(end, { day: 'numeric', month: 'short' })}`;
}

/**
 * Reach and interactions for posts we published ourselves, keyed by the media
 * id the publisher recorded. Only auto-published entries carry one — an entry
 * posted by hand has no link back to the post it became, and inventing one by
 * matching timestamps would attach real numbers to the wrong row.
 */
async function publishedOutcomes(): Promise<
  Map<string, { reach: number | null; totalInteractions: number | null }>
> {
  const rows = await db()
    .select({
      igMediaId: posts.igMediaId,
      reach: postInsights.reach,
      totalInteractions: postInsights.totalInteractions,
    })
    .from(posts)
    .leftJoin(
      postInsights,
      and(eq(postInsights.postId, posts.id), eq(postInsights.checkpoint, 'latest')),
    )
    .where(isNotNull(posts.igMediaId));

  const map = new Map<string, { reach: number | null; totalInteractions: number | null }>();
  for (const row of rows) {
    if (row.igMediaId) {
      map.set(row.igMediaId, {
        reach: row.reach,
        totalInteractions: row.totalInteractions,
      });
    }
  }
  return map;
}

/** Entries whose scheduled slot has passed without being posted. */
export async function overdueCount(now: Date = new Date()): Promise<number> {
  const entries = await db()
    .select()
    .from(calendarEntries)
    .where(eq(calendarEntries.status, 'planned'));
  return entries.filter((e) => entryState(e, now) === 'overdue').length;
}
