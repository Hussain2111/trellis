import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { accounts, hookLabels, posts, type Post } from '../db/schema';
import { median } from './posts';

/**
 * Ideas ranks posts by how far they beat *their own account's* normal, not by
 * raw likes.
 *
 * Raw likes just rank accounts by size — a 500k account's average post buries
 * a 5k account's genuine breakout, and the breakout is the interesting one.
 * Dividing by the posting account's own trailing median normalises that away:
 * a score of 4 means "this did four times what that account usually does",
 * which is the same claim whatever the account's size.
 */

/** Below this many posts, an account's median is noise and the ratio is meaningless. */
export const MIN_POSTS_FOR_BASELINE = 5;

export interface Idea {
  post: Post;
  handle: string;
  followers: number | null;
  hookCategory: string | null;
  engagement: number;
  /** The account's own trailing median engagement — the denominator, shown so the score is checkable. */
  baseline: number;
  viralScore: number;
}

export interface IdeasResult {
  ideas: Idea[];
  /** Accounts skipped for having too little history to have a baseline at all. */
  skippedAccounts: { handle: string; posts: number }[];
  windowDays: number;
}

function engagementOf(post: Post): number | null {
  if (post.likes == null && post.comments == null) return null;
  return (post.likes ?? 0) + (post.comments ?? 0);
}

/**
 * Competitor posts that beat their own account's baseline by the widest
 * margin, newest window first.
 *
 * The baseline is computed over the account's whole held history, not just the
 * window: a median taken over the same few recent posts a breakout is in would
 * be dragged upward by that very breakout.
 */
export async function ideas(
  options: { windowDays?: number; limit?: number; minScore?: number } = {},
): Promise<IdeasResult> {
  const windowDays = options.windowDays ?? 60;
  const minScore = options.minScore ?? 1.5;
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const competitors = await db().select().from(accounts).where(eq(accounts.role, 'competitor'));
  if (competitors.length === 0) return { ideas: [], skippedAccounts: [], windowDays };

  const competitorIds = competitors.map((a) => a.id);
  const allPosts = await db().select().from(posts).where(inArray(posts.accountId, competitorIds));

  const byAccount = new Map<number, Post[]>();
  for (const post of allPosts) {
    const list = byAccount.get(post.accountId) ?? [];
    list.push(post);
    byAccount.set(post.accountId, list);
  }

  const recent = await db()
    .select({ post: posts, hookCategory: hookLabels.category })
    .from(posts)
    .leftJoin(hookLabels, eq(hookLabels.postId, posts.id))
    .where(inArray(posts.accountId, competitorIds))
    .orderBy(desc(posts.takenAt));

  const skippedAccounts: { handle: string; posts: number }[] = [];
  const baselines = new Map<number, number>();

  for (const account of competitors) {
    const held = byAccount.get(account.id) ?? [];
    const values = held.map(engagementOf).filter((v): v is number => v != null);
    if (values.length < MIN_POSTS_FOR_BASELINE) {
      skippedAccounts.push({ handle: account.handle, posts: values.length });
      continue;
    }
    const baseline = median(values);
    // A zero median makes every ratio infinite; there is no honest score there.
    if (baseline == null || baseline <= 0) {
      skippedAccounts.push({ handle: account.handle, posts: values.length });
      continue;
    }
    baselines.set(account.id, baseline);
  }

  const handles = new Map(competitors.map((a) => [a.id, a]));

  const scored: Idea[] = [];
  for (const { post, hookCategory } of recent) {
    const baseline = baselines.get(post.accountId);
    if (baseline === undefined) continue;
    if (post.takenAt && post.takenAt < since) continue;

    const engagement = engagementOf(post);
    if (engagement == null) continue;

    const viralScore = engagement / baseline;
    if (viralScore < minScore) continue;

    const account = handles.get(post.accountId)!;
    scored.push({
      post,
      handle: account.handle,
      followers: account.followers,
      hookCategory,
      engagement,
      baseline,
      viralScore,
    });
  }

  return {
    ideas: scored.sort((a, b) => b.viralScore - a.viralScore).slice(0, options.limit ?? 30),
    skippedAccounts,
    windowDays,
  };
}

/** Which hook categories show up most among the breakouts. */
export function hooksAmongIdeas(list: Idea[]): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const idea of list) {
    if (!idea.hookCategory) continue;
    counts.set(idea.hookCategory, (counts.get(idea.hookCategory) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

/** The managed account's own breakouts, scored the same way. */
export async function ownBreakouts(
  accountId: number,
  options: { windowDays?: number; minScore?: number } = {},
): Promise<Idea[]> {
  const windowDays = options.windowDays ?? 180;
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const [account] = await db().select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account) return [];

  const held = await db().select().from(posts).where(eq(posts.accountId, accountId));
  const values = held.map(engagementOf).filter((v): v is number => v != null);
  if (values.length < MIN_POSTS_FOR_BASELINE) return [];

  const baseline = median(values);
  if (baseline == null || baseline <= 0) return [];

  const rows = await db()
    .select({ post: posts, hookCategory: hookLabels.category })
    .from(posts)
    .leftJoin(hookLabels, eq(hookLabels.postId, posts.id))
    .where(eq(posts.accountId, accountId))
    .orderBy(desc(posts.takenAt));

  return rows
    .filter((r) => !r.post.takenAt || r.post.takenAt >= since)
    .map((r) => {
      const engagement = engagementOf(r.post);
      return engagement == null
        ? null
        : {
            post: r.post,
            handle: account.handle,
            followers: account.followers,
            hookCategory: r.hookCategory,
            engagement,
            baseline,
            viralScore: engagement / baseline,
          };
    })
    .filter((i): i is Idea => i !== null && i.viralScore >= (options.minScore ?? 1.5))
    .sort((a, b) => b.viralScore - a.viralScore);
}
