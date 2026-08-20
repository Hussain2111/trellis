import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { accounts, posts, type Account } from '../db/schema';
import { isScanDue } from '../ingest/upsert';
import { median } from './posts';

/**
 * Per-competitor stats for the Competitors table.
 *
 * The point of the extra columns is to make a stale or thin competitor
 * visible. A competitor with four posts held drags the pool's sample size
 * around without contributing much, and one last scanned six weeks ago is
 * being compared against on numbers that have moved — neither is obvious from
 * a handle and a follower count alone.
 */

export interface CompetitorStats {
  account: Account;
  postsHeld: number;
  medianEngagement: number | null;
  newestPost: Date | null;
  /** True when the weekly pass would re-scan this account on its next run. */
  dueForRescan: boolean;
}

export async function competitorStats(cooldownDays = 7): Promise<CompetitorStats[]> {
  const competitors = await db().select().from(accounts).where(eq(accounts.role, 'competitor'));
  if (competitors.length === 0) return [];

  const held = await db()
    .select()
    .from(posts)
    .where(
      inArray(
        posts.accountId,
        competitors.map((a) => a.id),
      ),
    );

  const byAccount = new Map<number, typeof held>();
  for (const post of held) {
    const list = byAccount.get(post.accountId) ?? [];
    list.push(post);
    byAccount.set(post.accountId, list);
  }

  return competitors
    .map((account) => {
      const theirs = byAccount.get(account.id) ?? [];
      const engagements = theirs
        .map((p) =>
          p.likes == null && p.comments == null ? null : (p.likes ?? 0) + (p.comments ?? 0),
        )
        .filter((v): v is number => v != null);
      const dates = theirs.map((p) => p.takenAt).filter((d): d is Date => d != null);

      return {
        account,
        postsHeld: theirs.length,
        medianEngagement: median(engagements),
        newestPost: dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null,
        dueForRescan: isScanDue(account, cooldownDays),
      };
    })
    .sort((a, b) => (b.medianEngagement ?? 0) - (a.medianEngagement ?? 0));
}
