import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { hookLabels, postFeatures, posts, resurfacedPosts } from '../db/schema';

export interface ResurfacedEntry {
  postId: number;
  metric: string;
  peakValue: number;
  daysSinceRepeated: number;
}

/**
 * "Your DM-funnel reel hit 552K, you haven't made one like it in 30 days" —
 * entirely deterministic, no model call. Groups the account's own posts by
 * hook category, finds the best-ever ("outlier") post in each category, and
 * flags categories whose most recent post is stale.
 */
export async function mineBackCatalog(
  accountId: number,
  staleDays = 30,
): Promise<ResurfacedEntry[]> {
  const rows = await db()
    .select({
      id: posts.id,
      takenAt: posts.takenAt,
      likes: posts.likes,
      isOutlier: postFeatures.isOutlier,
      hookCategory: hookLabels.category,
    })
    .from(posts)
    .innerJoin(postFeatures, eq(postFeatures.postId, posts.id))
    .leftJoin(hookLabels, eq(hookLabels.postId, posts.id))
    .where(eq(posts.accountId, accountId));

  const byCategory = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.hookCategory) continue;
    const list = byCategory.get(row.hookCategory) ?? [];
    list.push(row);
    byCategory.set(row.hookCategory, list);
  }

  const now = Date.now();
  const results: ResurfacedEntry[] = [];

  for (const categoryPosts of byCategory.values()) {
    const outliers = categoryPosts.filter((p) => p.isOutlier);
    if (outliers.length === 0) continue;

    const peak = outliers.reduce((best, p) => ((p.likes ?? 0) > (best.likes ?? 0) ? p : best));
    const mostRecent = categoryPosts.reduce((latest, p) =>
      (p.takenAt?.getTime() ?? 0) > (latest.takenAt?.getTime() ?? 0) ? p : latest,
    );
    const daysSince = mostRecent.takenAt
      ? Math.floor((now - mostRecent.takenAt.getTime()) / 86_400_000)
      : Number.POSITIVE_INFINITY;

    if (daysSince >= staleDays) {
      results.push({
        postId: peak.id,
        metric: 'likes',
        peakValue: peak.likes ?? 0,
        daysSinceRepeated: daysSince,
      });
    }
  }

  return results.sort((a, b) => b.peakValue - a.peakValue);
}

/** Idempotent: clears this account's prior resurfaced entries and writes the current set. */
export async function persistBackCatalog(
  accountId: number,
  entries: ResurfacedEntry[],
): Promise<void> {
  const accountPosts = await db()
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.accountId, accountId));
  const accountPostIds = accountPosts.map((p) => p.id);
  if (accountPostIds.length === 0) return;

  await db().transaction(async (tx) => {
    await tx.delete(resurfacedPosts).where(inArray(resurfacedPosts.postId, accountPostIds));
    for (const entry of entries) {
      await tx.insert(resurfacedPosts).values(entry);
    }
  });
}
