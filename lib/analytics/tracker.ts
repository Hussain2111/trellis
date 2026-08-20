import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { postInsights, posts, type Post, type PostInsight } from '../db/schema';

/**
 * Post Tracker answers a different question from Post Analytics. Analytics
 * asks "how did this post do"; Tracker asks "is it still going" — which is
 * only visible as the difference between the same metric at 24 hours, 48
 * hours and 7 days.
 *
 * That is why `post_insights` stores fixed checkpoints that are written once
 * and never overwritten. A single mutable "current" row would make growth
 * unknowable after the fact.
 */

export type Checkpoint = 't24' | 't48' | 't7d';
export const CHECKPOINTS: Checkpoint[] = ['t24', 't48', 't7d'];

export interface TrackedPost {
  post: Post;
  ageHours: number | null;
  points: Record<Checkpoint | 'latest', PostInsight | null>;
  /** Reach gained between the first and last checkpoint we hold. */
  reachGrowth: number | null;
  /** Reach added since the last fixed checkpoint — "still travelling" if positive. */
  sinceLastCheckpoint: number | null;
  /** Which checkpoint the post is waiting on, if any. */
  awaiting: Checkpoint | null;
  status: 'too new' | 'climbing' | 'settled' | 'not measured';
}

function ageHoursOf(takenAt: Date | null, now: Date): number | null {
  return takenAt ? (now.getTime() - takenAt.getTime()) / 3_600_000 : null;
}

/** The first checkpoint the post is old enough for but has no row yet. */
function awaitingCheckpoint(ageHours: number | null, held: Set<string>): Checkpoint | null {
  if (ageHours == null) return null;
  const thresholds: [Checkpoint, number][] = [
    ['t24', 24],
    ['t48', 48],
    ['t7d', 168],
  ];
  for (const [checkpoint, hours] of thresholds) {
    if (ageHours < hours) return checkpoint;
    if (!held.has(checkpoint)) return checkpoint;
  }
  return null;
}

export async function trackedPosts(accountId: number, limit = 25): Promise<TrackedPost[]> {
  const now = new Date();
  const postRows = await db()
    .select()
    .from(posts)
    .where(eq(posts.accountId, accountId))
    .orderBy(desc(posts.takenAt))
    .limit(limit);

  if (postRows.length === 0) return [];

  const insightRows = await db()
    .select()
    .from(postInsights)
    .where(
      inArray(
        postInsights.postId,
        postRows.map((p) => p.id),
      ),
    );

  const byPost = new Map<number, PostInsight[]>();
  for (const row of insightRows) {
    const list = byPost.get(row.postId) ?? [];
    list.push(row);
    byPost.set(row.postId, list);
  }

  return postRows.map((post) => {
    const held = byPost.get(post.id) ?? [];
    const points = {
      t24: held.find((r) => r.checkpoint === 't24') ?? null,
      t48: held.find((r) => r.checkpoint === 't48') ?? null,
      t7d: held.find((r) => r.checkpoint === 't7d') ?? null,
      latest: held.find((r) => r.checkpoint === 'latest') ?? null,
    };

    const ageHours = ageHoursOf(post.takenAt, now);
    const fixed = CHECKPOINTS.map((c) => points[c]).filter(
      (r): r is PostInsight => r !== null && r.reach != null,
    );

    const first = fixed[0] ?? null;
    const last = fixed[fixed.length - 1] ?? null;
    const reachGrowth =
      first && last && first !== last ? (last.reach ?? 0) - (first.reach ?? 0) : null;

    const sinceLastCheckpoint =
      last?.reach != null && points.latest?.reach != null ? points.latest.reach - last.reach : null;

    const awaiting = awaitingCheckpoint(ageHours, new Set(held.map((r) => r.checkpoint)));

    return {
      post,
      ageHours,
      points,
      reachGrowth,
      sinceLastCheckpoint,
      awaiting,
      status: statusOf(ageHours, points.latest, sinceLastCheckpoint),
    };
  });
}

function statusOf(
  ageHours: number | null,
  latest: PostInsight | null,
  sinceLastCheckpoint: number | null,
): TrackedPost['status'] {
  if (latest == null || latest.reach == null) {
    // Under a day old with nothing captured yet is expected, not a failure.
    return ageHours != null && ageHours < 24 ? 'too new' : 'not measured';
  }
  if (sinceLastCheckpoint == null) return ageHours != null && ageHours < 24 ? 'too new' : 'settled';
  // A percent threshold rather than "any movement at all": reach ticks up by a
  // handful for weeks on almost every post, and calling that "climbing" would
  // make the label meaningless.
  const base = latest.reach - sinceLastCheckpoint;
  const growth = base > 0 ? sinceLastCheckpoint / base : 0;
  return growth >= 0.05 ? 'climbing' : 'settled';
}

export interface TrackerSummary {
  climbing: number;
  settled: number;
  awaitingCapture: number;
  tooNew: number;
}

export function summariseTracker(rows: TrackedPost[]): TrackerSummary {
  return {
    climbing: rows.filter((r) => r.status === 'climbing').length,
    settled: rows.filter((r) => r.status === 'settled').length,
    awaitingCapture: rows.filter((r) => r.awaiting !== null && r.status !== 'too new').length,
    tooNew: rows.filter((r) => r.status === 'too new').length,
  };
}
