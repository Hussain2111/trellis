import { tool } from 'ai';
import { z } from 'zod';
import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { posts, type Post } from '../db/schema';
import { summariseByFormat } from '../analysis/features';
import { poolComposition } from '../analysis/corpus';
import { mineBackCatalog } from '../analysis/back-catalog';
import { latestAnalysis } from '../analysis/analysis';
import { listAccounts as listAllAccounts, selfAccount } from '../ingest/upsert';

/**
 * The coach's tools. Every one reads data this build already computed — no
 * tool call spends model quota, and there is nothing here that writes
 * anything: the spec asks the chat coach to answer questions and give
 * advice "grounded in the computed analysis," not to act on the user's
 * behalf.
 */

const compactPost = (p: Post) => ({
  id: p.id,
  shortcode: p.shortcode,
  type: p.type,
  likes: p.likes,
  comments: p.comments,
  views: p.views,
  takenAt: p.takenAt,
  caption: (p.caption ?? '').slice(0, 200),
});

export function coachTools() {
  return {
    getAccountStats: tool({
      description:
        "Overall stats for the user's own account: followers, post count, per-format medians.",
      inputSchema: z.object({}),
      execute: async () => {
        const self = await selfAccount();
        if (!self) return { error: 'No account is marked as yours yet.' };
        const rows = await db().select().from(posts).where(eq(posts.accountId, self.id));
        return {
          handle: self.handle,
          followers: self.followers,
          niche: self.niche,
          postsAnalysed: rows.length,
          lastScrapedAt: self.lastScrapedAt,
          byFormat: summariseByFormat(rows, self.followers),
        };
      },
    }),

    getPosts: tool({
      description:
        "Fetch the user's posts with optional filters. Use this instead of guessing at what they have posted.",
      inputSchema: z.object({
        type: z.enum(['image', 'carousel', 'reel', 'video', 'any']).default('any'),
        sort: z.enum(['recent', 'top']).default('recent'),
        limit: z.number().int().min(1).max(25).default(10),
      }),
      execute: async ({ type, sort, limit }) => {
        const self = await selfAccount();
        if (!self) return { error: 'No account is marked as yours yet.' };
        const rows = await db()
          .select()
          .from(posts)
          .where(eq(posts.accountId, self.id))
          .orderBy(sort === 'top' ? desc(posts.likes) : desc(posts.takenAt))
          .limit(200);
        const filtered = rows.filter((p) => type === 'any' || p.type === type).slice(0, limit);
        return { count: filtered.length, posts: filtered.map(compactPost) };
      },
    }),

    getCompetitorStats: tool({
      description:
        'The competitor pool: who is in it, how big they are, and how the benchmark breaks down by format.',
      inputSchema: z.object({}),
      execute: async () => {
        const pool = await poolComposition();
        const competitorAccountIds = (await listAllAccounts('competitor')).map((a) => a.id);
        const competitorPosts = competitorAccountIds.length
          ? await db().select().from(posts).where(inArray(posts.accountId, competitorAccountIds))
          : [];
        return { pool, byFormat: summariseByFormat(competitorPosts, null) };
      },
    }),

    getCurrentPatterns: tool({
      description:
        'The most recent analysis: the winning patterns in this niche ranked by how far ahead of the user they are, with their numbers.',
      inputSchema: z.object({}),
      execute: async () => {
        const analysis = await latestAnalysis();
        if (!analysis) return { error: 'No analysis has been run yet.' };
        return {
          createdAt: analysis.createdAt,
          windowDays: analysis.windowDays,
          generatedBy: analysis.generatedBy,
          patterns: analysis.patterns,
        };
      },
    }),

    getMyWinners: tool({
      description:
        "The user's own outlier posts, grouped by hook category, not repeated recently — the back catalogue worth mining.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(20).default(10) }),
      execute: async ({ limit }) => {
        const self = await selfAccount();
        if (!self) return { error: 'No account is marked as yours yet.' };
        const entries = await mineBackCatalog(self.id);
        return { entries: entries.slice(0, limit) };
      },
    }),

    listAccounts: tool({
      description: 'All accounts being tracked, mine and competitors, with their ids.',
      inputSchema: z.object({}),
      execute: async () => ({
        accounts: (await listAllAccounts()).map((a) => ({
          id: a.id,
          handle: a.handle,
          role: a.role,
          followers: a.followers,
          lastScrapedAt: a.lastScrapedAt,
        })),
      }),
    }),
  };
}
