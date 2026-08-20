import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { postComments, posts } from '../db/schema';

/**
 * Most Active Followers, as a rolling aggregate over `post_comments`.
 *
 * Deliberately not a stored ranking: it would be stale the moment a comment
 * landed, and the group-by is cheap.
 *
 * The honest limitation, which the page states rather than hides: this is a
 * ranking of *commenters*, not of engaged followers generally. The Graph API
 * exposes who commented but not who liked or saved, so a follower who likes
 * every post and never types is invisible here. Calling this "most engaged"
 * would be a claim the data cannot support.
 */

export interface ActiveFollower {
  username: string;
  comments: number;
  postsCommentedOn: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
}

export async function mostActiveFollowers(
  accountId: number,
  options: { windowDays?: number; limit?: number } = {},
): Promise<ActiveFollower[]> {
  const windowDays = options.windowDays ?? 90;
  const since = new Date(Date.now() - windowDays * 86_400_000);

  return db()
    .select({
      username: sql<string>`${postComments.username}`,
      comments: sql<number>`count(*)::int`,
      postsCommentedOn: sql<number>`count(distinct ${postComments.postId})::int`,
      firstSeen: sql<Date | null>`min(${postComments.commentedAt})`,
      lastSeen: sql<Date | null>`max(${postComments.commentedAt})`,
    })
    .from(postComments)
    .innerJoin(posts, eq(posts.id, postComments.postId))
    .where(
      and(
        eq(posts.accountId, accountId),
        isNotNull(postComments.username),
        // A comment with no timestamp can't be placed in the window at all,
        // so it is left out rather than assumed recent.
        gte(postComments.commentedAt, since),
      ),
    )
    .groupBy(postComments.username)
    .orderBy(sql`count(*) desc, max(${postComments.commentedAt}) desc`)
    .limit(options.limit ?? 50);
}

export interface AudienceSummary {
  windowDays: number;
  totalComments: number;
  uniqueCommenters: number;
  postsWithComments: number;
  /** Comments we hold that carry no timestamp, and so sit outside every window. */
  undated: number;
  /**
   * The oldest comment actually held. The 90-day window is a ceiling, not a
   * promise: `sync_own_account` pulls comments for its `commentLimit` most
   * recent posts (10 by default), so real coverage is "your last N posts",
   * which for an active account is far short of 90 days. The page states this
   * rather than implying a clean 90-day sweep.
   */
  oldestComment: Date | null;
  newestComment: Date | null;
}

export async function audienceSummary(
  accountId: number,
  windowDays = 90,
): Promise<AudienceSummary> {
  // Bound as ISO text and cast, not as a Date: drizzle's raw `sql` template
  // hands the value straight to postgres-js, which cannot serialise a Date
  // without a column type to infer from.
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const [row] = await db()
    .select({
      totalComments: sql<number>`count(*) filter (where ${postComments.commentedAt} >= ${since}::timestamptz)::int`,
      uniqueCommenters: sql<number>`count(distinct ${postComments.username}) filter (where ${postComments.commentedAt} >= ${since}::timestamptz)::int`,
      postsWithComments: sql<number>`count(distinct ${postComments.postId}) filter (where ${postComments.commentedAt} >= ${since}::timestamptz)::int`,
      undated: sql<number>`count(*) filter (where ${postComments.commentedAt} is null)::int`,
      oldestComment: sql<string | null>`min(${postComments.commentedAt})`,
      newestComment: sql<string | null>`max(${postComments.commentedAt})`,
    })
    .from(postComments)
    .innerJoin(posts, eq(posts.id, postComments.postId))
    .where(eq(posts.accountId, accountId));

  return {
    windowDays,
    totalComments: row?.totalComments ?? 0,
    uniqueCommenters: row?.uniqueCommenters ?? 0,
    postsWithComments: row?.postsWithComments ?? 0,
    undated: row?.undated ?? 0,
    // A raw `sql` aggregate has no column type for postgres-js to parse
    // against, so these arrive as strings. Coerce here rather than leaving
    // every caller to discover it.
    oldestComment: toDate(row?.oldestComment),
    newestComment: toDate(row?.newestComment),
  };
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

export interface RepeatBreakdown {
  oneOff: number;
  occasional: number;
  regular: number;
}

/**
 * How much of the comment volume is the same handful of people. A large
 * `regular` count against a small `oneOff` count means the comments are a
 * core group talking, not new reach arriving.
 */
export function repeatBreakdown(followers: ActiveFollower[]): RepeatBreakdown {
  return {
    oneOff: followers.filter((f) => f.comments === 1).length,
    occasional: followers.filter((f) => f.comments >= 2 && f.comments < 5).length,
    regular: followers.filter((f) => f.comments >= 5).length,
  };
}
