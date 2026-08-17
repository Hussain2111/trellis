import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { accounts, hookLabels, postFeatures, posts } from '../db/schema';
import type { EnrichedPost } from './patterns';

export interface PoolComposition {
  accounts: { handle: string; role: 'self' | 'competitor'; postCount: number }[];
  totalPosts: number;
  warning: string | null;
}

/** Everything the pattern engine needs, joined once. Not paginated — this build's corpus is at most a few hundred posts. */
export async function loadCorpus(): Promise<EnrichedPost[]> {
  const rows = await db()
    .select({
      id: posts.id,
      role: accounts.role,
      type: posts.type,
      engagementRate: postFeatures.engagementRate,
      postedHour: postFeatures.postedHour,
      hasCta: postFeatures.hasCta,
      hasQuestion: postFeatures.hasQuestion,
      hookCategory: hookLabels.category,
    })
    .from(posts)
    .innerJoin(accounts, eq(accounts.id, posts.accountId))
    .leftJoin(postFeatures, eq(postFeatures.postId, posts.id))
    .leftJoin(hookLabels, eq(hookLabels.postId, posts.id));

  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    type: r.type,
    engagementRate: r.engagementRate,
    postedHour: r.postedHour,
    hasCta: r.hasCta ?? false,
    hasQuestion: r.hasQuestion ?? false,
    hookCategory: r.hookCategory,
  }));
}

/**
 * Sample-size honesty: a "51% vs your 20%" claim built on nine posts is
 * noise, and the UI has to be able to say so.
 */
export async function poolComposition(): Promise<PoolComposition> {
  const rows = await db()
    .select({ handle: accounts.handle, role: accounts.role })
    .from(accounts)
    .innerJoin(posts, eq(posts.accountId, accounts.id));

  const counts = new Map<string, { role: 'self' | 'competitor'; count: number }>();
  for (const row of rows) {
    const entry = counts.get(row.handle) ?? { role: row.role, count: 0 };
    entry.count++;
    counts.set(row.handle, entry);
  }

  const accountSummaries = [...counts.entries()].map(([handle, v]) => ({
    handle,
    role: v.role,
    postCount: v.count,
  }));
  const competitorAccounts = accountSummaries.filter((a) => a.role === 'competitor');
  const totalPosts = accountSummaries.reduce((sum, a) => sum + a.postCount, 0);

  let warning: string | null = null;
  if (competitorAccounts.length < 3) {
    warning = `Only ${competitorAccounts.length} competitor account(s) scanned — patterns will be noisy until more are in.`;
  } else if (totalPosts < 50) {
    warning = `Only ${totalPosts} posts in the pool — treat percentages as directional, not precise.`;
  }

  return { accounts: accountSummaries, totalPosts, warning };
}
