import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { accounts, posts, type Post } from '../db/schema';
import { extractHashtags } from '../analysis/hashtags';
import { median } from './posts';

/**
 * Hot Topics: which hashtags the niche is using *more* than it was, and how
 * those posts perform.
 *
 * Deterministic, and deliberately so — no model call decides what is trending.
 * A topic is "rising" because it appears in more posts this window than last,
 * which is a countable fact, not because a model was asked to characterise the
 * mood of a feed.
 *
 * The comparison is share-of-posts, not raw count. A window where the pool
 * simply posted more would inflate every raw count and make everything look
 * like it was rising.
 */

/** Below this many posts in the recent window, a tag's movement is noise. */
export const MIN_POSTS_FOR_TREND = 3;

export interface Topic {
  tag: string;
  recentPosts: number;
  priorPosts: number;
  /** Share of the recent window's posts using this tag, 0..1. */
  recentShare: number;
  priorShare: number;
  /** Percentage-point change in share. Null when the prior window is empty. */
  shareDeltaPct: number | null;
  medianEngagement: number | null;
  /** Ratio of this tag's median engagement to the pool's overall median. */
  performanceRatio: number | null;
  usedByAccounts: number;
  /** Whether the managed account has used this tag in the recent window. */
  usedByYou: boolean;
}

export interface TopicsResult {
  rising: Topic[];
  strongest: Topic[];
  windowDays: number;
  recentPostCount: number;
  priorPostCount: number;
  poolMedianEngagement: number | null;
}

function engagementOf(post: Post): number | null {
  if (post.likes == null && post.comments == null) return null;
  return (post.likes ?? 0) + (post.comments ?? 0);
}

function inWindow(post: Post, from: Date, to: Date): boolean {
  // A post with no timestamp cannot be placed in either window, so it is
  // counted in neither rather than assumed recent.
  return post.takenAt != null && post.takenAt >= from && post.takenAt < to;
}

export async function hotTopics(
  options: { windowDays?: number; limit?: number } = {},
): Promise<TopicsResult> {
  const windowDays = options.windowDays ?? 30;
  const limit = options.limit ?? 15;
  const now = new Date();
  const recentFrom = new Date(now.getTime() - windowDays * 86_400_000);
  const priorFrom = new Date(now.getTime() - 2 * windowDays * 86_400_000);

  const competitors = await db().select().from(accounts).where(eq(accounts.role, 'competitor'));
  const [self] = await db().select().from(accounts).where(eq(accounts.role, 'self')).limit(1);

  if (competitors.length === 0) {
    return {
      rising: [],
      strongest: [],
      windowDays,
      recentPostCount: 0,
      priorPostCount: 0,
      poolMedianEngagement: null,
    };
  }

  const pool = await db()
    .select()
    .from(posts)
    .where(
      inArray(
        posts.accountId,
        competitors.map((a) => a.id),
      ),
    );

  const recent = pool.filter((p) => inWindow(p, recentFrom, now));
  const prior = pool.filter((p) => inWindow(p, priorFrom, recentFrom));

  const poolMedian = median(recent.map(engagementOf).filter((v): v is number => v != null));

  const yourTags = new Set<string>();
  if (self) {
    const yours = await db().select().from(posts).where(eq(posts.accountId, self.id));
    for (const post of yours.filter((p) => inWindow(p, recentFrom, now))) {
      for (const tag of extractHashtags(post.caption)) yourTags.add(tag);
    }
  }

  const recentStats = tally(recent);
  const priorStats = tally(prior);

  const topics: Topic[] = [];
  for (const [tag, stat] of recentStats) {
    if (stat.posts.length < MIN_POSTS_FOR_TREND) continue;

    const priorCount = priorStats.get(tag)?.posts.length ?? 0;
    const recentShare = recent.length > 0 ? stat.posts.length / recent.length : 0;
    const priorShare = prior.length > 0 ? priorCount / prior.length : 0;

    const tagMedian = median(stat.posts.map(engagementOf).filter((v): v is number => v != null));

    topics.push({
      tag,
      recentPosts: stat.posts.length,
      priorPosts: priorCount,
      recentShare,
      priorShare,
      // With no prior window there is nothing to compare against; that is not
      // the same as "no change", so it stays null.
      shareDeltaPct: prior.length > 0 ? (recentShare - priorShare) * 100 : null,
      medianEngagement: tagMedian,
      performanceRatio:
        tagMedian != null && poolMedian != null && poolMedian > 0 ? tagMedian / poolMedian : null,
      usedByAccounts: stat.accounts.size,
      usedByYou: yourTags.has(tag),
    });
  }

  return {
    rising: [...topics]
      .filter((t) => t.shareDeltaPct != null && t.shareDeltaPct > 0)
      .sort((a, b) => (b.shareDeltaPct ?? 0) - (a.shareDeltaPct ?? 0))
      .slice(0, limit),
    strongest: [...topics]
      .filter((t) => t.performanceRatio != null)
      .sort((a, b) => (b.performanceRatio ?? 0) - (a.performanceRatio ?? 0))
      .slice(0, limit),
    windowDays,
    recentPostCount: recent.length,
    priorPostCount: prior.length,
    poolMedianEngagement: poolMedian,
  };
}

function tally(list: Post[]): Map<string, { posts: Post[]; accounts: Set<number> }> {
  const stats = new Map<string, { posts: Post[]; accounts: Set<number> }>();
  for (const post of list) {
    // A tag used five times in one caption is still one post using it.
    for (const tag of new Set(extractHashtags(post.caption))) {
      const stat = stats.get(tag) ?? { posts: [], accounts: new Set<number>() };
      stat.posts.push(post);
      stat.accounts.add(post.accountId);
      stats.set(tag, stat);
    }
  }
  return stats;
}
