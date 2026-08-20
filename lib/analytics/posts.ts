import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { postInsights, posts, type Post } from '../db/schema';

/**
 * The read side of Post Analytics. Everything here is a query — nothing is
 * precomputed and stored, because insights move and a cached ranking would be
 * wrong within a day.
 *
 * The rule the whole module follows: a number that isn't known is `null`, and
 * `null` renders as a blank. Reach is only available for Graph-sourced posts,
 * and only for as far back as Meta's insight lookback reaches, so a v1-era
 * scraped post has likes and comments but no reach — and that gap is shown as
 * a gap rather than filled with a zero or a guess.
 */

export interface PostRow {
  post: Post;
  reach: number | null;
  views: number | null;
  saves: number | null;
  shares: number | null;
  totalInteractions: number | null;
  /** Interactions ÷ reach. Null unless both are known and reach is non-zero. */
  engagementOnReach: number | null;
  /** (likes + comments) ÷ followers. The v1-comparable rate; needs a follower count. */
  engagementOnFollowers: number | null;
  capturedAt: Date | null;
  unavailable: string[];
}

/** Interactions, preferring Meta's own total and falling back to what we hold. */
function interactionsOf(
  post: Post,
  insight: {
    totalInteractions: number | null;
    likes: number | null;
    comments: number | null;
  } | null,
): number | null {
  if (insight?.totalInteractions != null) return insight.totalInteractions;
  const likes = insight?.likes ?? post.likes;
  const comments = insight?.comments ?? post.comments;
  if (likes == null && comments == null) return null;
  return (likes ?? 0) + (comments ?? 0);
}

export async function postAnalytics(
  accountId: number,
  followers: number | null,
  limit = 100,
): Promise<PostRow[]> {
  const rows = await db()
    .select({ post: posts, insight: postInsights })
    .from(posts)
    .leftJoin(
      postInsights,
      and(eq(postInsights.postId, posts.id), eq(postInsights.checkpoint, 'latest')),
    )
    .where(eq(posts.accountId, accountId))
    .orderBy(desc(posts.takenAt))
    .limit(limit);

  return rows.map(({ post, insight }) => {
    const totalInteractions = interactionsOf(post, insight);
    const reach = insight?.reach ?? null;
    return {
      post,
      reach,
      views: insight?.views ?? post.views ?? null,
      saves: insight?.saves ?? null,
      shares: insight?.shares ?? null,
      totalInteractions,
      engagementOnReach:
        reach != null && reach > 0 && totalInteractions != null ? totalInteractions / reach : null,
      engagementOnFollowers:
        followers != null && followers > 0 && totalInteractions != null
          ? totalInteractions / followers
          : null,
      capturedAt: insight?.capturedAt ?? null,
      unavailable: insight?.unavailable ?? [],
    };
  });
}

export interface AnalyticsSummary {
  measured: number;
  unmeasured: number;
  medianReach: number | null;
  medianEngagementOnReach: number | null;
  totalSaves: number | null;
  totalShares: number | null;
}

/**
 * Medians, not means: one post that unexpectedly travels drags a mean far
 * enough to make it useless as a baseline, and the baseline is the whole
 * point of the number.
 */
export function summarise(rows: PostRow[]): AnalyticsSummary {
  const withReach = rows.filter((r) => r.reach != null);
  const withRate = rows.filter((r) => r.engagementOnReach != null);
  const saves = rows.filter((r) => r.saves != null);
  const shares = rows.filter((r) => r.shares != null);

  return {
    measured: withReach.length,
    unmeasured: rows.length - withReach.length,
    medianReach: median(withReach.map((r) => r.reach!)),
    medianEngagementOnReach: median(withRate.map((r) => r.engagementOnReach!)),
    totalSaves: saves.length > 0 ? saves.reduce((sum, r) => sum + r.saves!, 0) : null,
    totalShares: shares.length > 0 ? shares.reduce((sum, r) => sum + r.shares!, 0) : null,
  };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export interface FormatBreakdown {
  type: string;
  /** Posts of this format held, measured or not. */
  count: number;
  /**
   * How many of those actually carry reach — the real n behind the medians.
   * Reported separately because `count` is what a reader assumes the median
   * was computed over, and early on it is far larger: 17 images held with one
   * measured produces a confident-looking median from a sample of one.
   */
  measuredCount: number;
  medianReach: number | null;
  medianEngagementOnReach: number | null;
}

/** How each format actually performs — the "should I make more reels" question. */
export function byFormat(rows: PostRow[]): FormatBreakdown[] {
  const groups = new Map<string, PostRow[]>();
  for (const row of rows) {
    const list = groups.get(row.post.type) ?? [];
    list.push(row);
    groups.set(row.post.type, list);
  }

  return [...groups.entries()]
    .map(([type, list]) => {
      const measured = list.filter((r) => r.reach != null);
      return {
        type,
        count: list.length,
        measuredCount: measured.length,
        medianReach: median(measured.map((r) => r.reach!)),
        medianEngagementOnReach: median(
          list.filter((r) => r.engagementOnReach != null).map((r) => r.engagementOnReach!),
        ),
      };
    })
    .sort((a, b) => b.count - a.count);
}

/** How many of an account's posts carry Graph insights at all. */
export async function insightCoverage(
  accountId: number,
): Promise<{ total: number; measured: number }> {
  const [row] = await db()
    .select({
      total: sql<number>`count(*)::int`,
      measured: sql<number>`count(${postInsights.id})::int`,
    })
    .from(posts)
    .leftJoin(
      postInsights,
      and(eq(postInsights.postId, posts.id), eq(postInsights.checkpoint, 'latest')),
    )
    .where(eq(posts.accountId, accountId));
  return { total: row?.total ?? 0, measured: row?.measured ?? 0 };
}
