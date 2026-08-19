import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { calendarEntries, followerDaily, postComments, postInsights, posts } from '../db/schema';
import { formatRiyadh, riyadhDay, startOfWeekRiyadh } from '../time';
import { median } from './posts';

/**
 * The weekly rollup: what happened, against the week before.
 *
 * Weeks are Monday 00:00 Riyadh to Monday 00:00 Riyadh, computed from the real
 * instant rather than from date strings, so a post at 01:00 Riyadh on a Monday
 * lands in the week it belongs to instead of the one before.
 *
 * Every comparison here can come back null. A metric with nothing to compare
 * against is not "no change" — the first week ever, or a week where the daily
 * sync never ran, has to read as unknown or the whole digest becomes fiction.
 */

export interface WeeklyMetric {
  label: string;
  value: number | null;
  previous: number | null;
  /** value - previous, or null when either side is unknown. */
  change: number | null;
  /** What the number means and what it excludes. Shown, not hidden in a tooltip. */
  note?: string;
}

export interface TopPost {
  id: number;
  shortcode: string;
  type: string;
  caption: string | null;
  reach: number | null;
  interactions: number | null;
  permalink: string | null;
}

export interface WeeklyReport {
  weekStart: Date;
  weekLabel: string;
  metrics: WeeklyMetric[];
  topPost: TopPost | null;
  /** Calendar entries scheduled in the week and how many actually went out. */
  planned: number;
  posted: number;
  missed: number;
  notes: string[];
}

/**
 * A week of posts is a handful of rows, so the aggregation happens in JS
 * rather than in SQL. That keeps the null handling explicit: `sum()` over an
 * all-null column returns null in Postgres but 0 through some drivers, and the
 * difference between "no reach recorded" and "reached nobody" is exactly what
 * this module must not blur.
 */
async function windowStats(from: Date, to: Date) {
  const rows = await db()
    .select({ post: posts, insight: postInsights })
    .from(posts)
    .leftJoin(
      postInsights,
      and(eq(postInsights.postId, posts.id), eq(postInsights.checkpoint, 'latest')),
    )
    .where(and(gte(posts.takenAt, from), lt(posts.takenAt, to)));

  const reaches = rows.map((r) => r.insight?.reach).filter((v): v is number => v != null);
  const interactions = rows
    .map((r) => r.insight?.totalInteractions)
    .filter((v): v is number => v != null);

  const [commentRow] = await db()
    .select({ comments: sql<number>`count(*)::int` })
    .from(postComments)
    .where(and(gte(postComments.commentedAt, from), lt(postComments.commentedAt, to)));

  return {
    posted: rows.length,
    totalReach: reaches.length > 0 ? reaches.reduce((a, b) => a + b, 0) : null,
    medianReach: median(reaches),
    totalInteractions: interactions.length > 0 ? interactions.reduce((a, b) => a + b, 0) : null,
    comments: commentRow?.comments ?? 0,
  };
}

/** Follower count on the last day of a window, and on the last day before it. */
async function followerChange(from: Date, to: Date): Promise<number | null> {
  const rows = await db()
    .select()
    .from(followerDaily)
    .where(and(gte(followerDaily.day, riyadhDay(from)), lt(followerDaily.day, riyadhDay(to))))
    .orderBy(followerDaily.day);

  const withCount = rows.filter((r) => r.followerCount != null);
  if (withCount.length < 2) return null;
  return withCount.at(-1)!.followerCount! - withCount[0]!.followerCount!;
}

export async function weeklyReport(now: Date = new Date()): Promise<WeeklyReport> {
  const weekStart = startOfWeekRiyadh(now);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
  const priorStart = new Date(weekStart.getTime() - 7 * 86_400_000);

  const current = await windowStats(weekStart, weekEnd);
  const prior = await windowStats(priorStart, weekStart);

  const followers = await followerChange(weekStart, weekEnd);
  const priorFollowers = await followerChange(priorStart, weekStart);

  const notes: string[] = [];
  if (current.posted > 0 && current.totalReach == null) {
    notes.push(
      'None of this week’s posts carry Instagram reach yet — insights are captured by the daily sync as each post ages.',
    );
  }
  if (followers === null) {
    notes.push(
      'Follower change needs at least two daily readings this week; there are fewer than two so far.',
    );
  }

  const metric = (
    label: string,
    value: number | null,
    previous: number | null,
    note?: string,
  ): WeeklyMetric => ({
    label,
    value,
    previous,
    change: value != null && previous != null ? value - previous : null,
    ...(note ? { note } : {}),
  });

  const entries = await db()
    .select()
    .from(calendarEntries)
    .where(
      and(gte(calendarEntries.scheduledFor, weekStart), lt(calendarEntries.scheduledFor, weekEnd)),
    );
  const posted = entries.filter((e) => e.status === 'published').length;

  return {
    weekStart,
    weekLabel: `${formatRiyadh(weekStart, { day: 'numeric', month: 'short' })} – ${formatRiyadh(
      new Date(weekEnd.getTime() - 1),
      { day: 'numeric', month: 'short' },
    )}`,
    metrics: [
      metric('Posts published', current.posted, prior.posted),
      metric(
        'Total reach',
        current.totalReach,
        prior.totalReach,
        'Sums only posts that carry Instagram insights.',
      ),
      metric('Median reach', current.medianReach, prior.medianReach),
      metric('Interactions', current.totalInteractions, prior.totalInteractions),
      metric(
        'Comments received',
        current.comments,
        prior.comments,
        'Counts comments the sync has pulled; very recent ones may not be in yet.',
      ),
      metric('Follower change', followers, priorFollowers),
    ],
    topPost: await topPostOfWeek(weekStart, weekEnd),
    planned: entries.length,
    posted,
    missed: entries.length - posted,
    notes,
  };
}

async function topPostOfWeek(from: Date, to: Date): Promise<TopPost | null> {
  const rows = await db()
    .select({
      id: posts.id,
      shortcode: posts.shortcode,
      type: posts.type,
      caption: posts.caption,
      permalink: posts.permalink,
      reach: postInsights.reach,
      interactions: postInsights.totalInteractions,
      likes: posts.likes,
      comments: posts.comments,
    })
    .from(posts)
    .leftJoin(
      postInsights,
      and(eq(postInsights.postId, posts.id), eq(postInsights.checkpoint, 'latest')),
    )
    .where(and(gte(posts.takenAt, from), lt(posts.takenAt, to)));

  if (rows.length === 0) return null;

  // Rank on reach where it exists, and fall back to interactions so a week
  // with no insights yet still names its strongest post rather than nothing.
  const scored = rows.map((r) => ({
    row: r,
    score: r.reach ?? r.interactions ?? (r.likes ?? 0) + (r.comments ?? 0),
  }));
  const best = scored.sort((a, b) => b.score - a.score)[0]!.row;

  return {
    id: best.id,
    shortcode: best.shortcode,
    type: best.type,
    caption: best.caption,
    reach: best.reach,
    interactions: best.interactions ?? (best.likes ?? 0) + (best.comments ?? 0),
    permalink: best.permalink,
  };
}
