import { tool } from 'ai';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { drafts, posts } from '../db/schema';
import {
  activeArchetypes,
  archetypeCrossTab,
  postsForArchetype,
} from '../analysis/archetypes';
import {
  benchmarkByFormat,
  benchmarkTraits,
  loadCorpus,
  myWinners,
  poolComposition,
} from '../analysis/benchmark';
import { summariseByFormat } from '../analysis/features';
import { latestAnalysis } from '../jobs/handlers/analysis';
import { insertDraft, draftById } from '../jobs/handlers/generate';
import { scheduleDraft } from '../jobs/handlers/publish';
import { activeVoice, saveVoice } from '../analysis/voice';
import { getAccount, listAccounts, selfAccount } from '../ingest/upsert';
import { enqueue } from '../jobs/queue';
import { getSettings } from '../settings';
import { draftSchema } from '../prompts/draft-generation.v1';
import { voiceFieldsSchema } from '../prompts/voice-profile.v1';

/**
 * The coach's tools. Everything here reads from the database it already has —
 * no tool costs quota, and only `triggerRescan` costs money, which is why it is
 * confirmation-gated rather than merely documented as expensive.
 */

const compactPost = (p: typeof posts.$inferSelect) => ({
  id: p.id,
  shortcode: p.shortcode,
  type: p.type,
  likes: p.likes,
  comments: p.comments,
  views: p.views,
  takenAt: p.takenAt,
  caption: (p.caption ?? '').slice(0, 200),
});

export function coachTools(options: { onRescanRequest?: (accountId: number) => void } = {}) {
  return {
    getAccountStats: tool({
      description: 'Overall stats for the user\'s own account: followers, post count, per-format medians.',
      inputSchema: z.object({}),
      execute: async () => {
        const self = selfAccount();
        if (!self) return { error: 'No account is marked as yours yet.' };
        const rows = db().select().from(posts).where(eq(posts.accountId, self.id)).all();
        return {
          handle: self.handle,
          followers: self.followers,
          postsAnalysed: rows.length,
          lastScrapedAt: self.lastScrapedAt,
          byFormat: summariseByFormat(rows, self.followers),
        };
      },
    }),

    getPosts: tool({
      description: 'Fetch the user\'s posts with optional filters. Use this instead of guessing at what they have posted.',
      inputSchema: z.object({
        type: z.enum(['image', 'carousel', 'reel', 'video', 'any']).default('any'),
        sort: z.enum(['recent', 'top']).default('recent'),
        limit: z.number().int().min(1).max(25).default(10),
        sinceDays: z.number().int().positive().optional(),
      }),
      execute: async ({ type, sort, limit, sinceDays }) => {
        const self = selfAccount();
        if (!self) return { error: 'No account is marked as yours yet.' };
        const cutoff = sinceDays ? Math.floor(Date.now() / 1000) - sinceDays * 86400 : 0;
        const rows = db()
          .select()
          .from(posts)
          .where(eq(posts.accountId, self.id))
          .orderBy(sort === 'top' ? desc(posts.likes) : desc(posts.takenAt))
          .all()
          .filter((p) => (type === 'any' || p.type === type) && (p.takenAt ?? 0) >= cutoff)
          .slice(0, limit);
        return { count: rows.length, posts: rows.map(compactPost) };
      },
    }),

    getCompetitorStats: tool({
      description: 'The competitor pool: who is in it, how big they are, and how the benchmark breaks down by format.',
      inputSchema: z.object({}),
      execute: async () => {
        const corpus = loadCorpus();
        return {
          pool: poolComposition(corpus),
          byFormat: benchmarkByFormat(corpus),
          traits: benchmarkTraits(corpus).slice(0, 6),
        };
      },
    }),

    getCurrentGap: tool({
      description: 'The most recent gap analysis: 5 winning patterns and the one headline gap, with their numbers.',
      inputSchema: z.object({}),
      execute: async () => {
        const analysis = latestAnalysis();
        if (!analysis) return { error: 'No analysis has been run yet.' };
        return {
          createdAt: analysis.createdAt,
          windowDays: analysis.windowDays,
          generatedBy: analysis.generatedBy,
          patterns: analysis.patterns,
          gap: analysis.gap,
        };
      },
    }),

    getMyWinners: tool({
      description: 'The user\'s own outlier posts — the back catalogue worth mining.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(20).default(10) }),
      execute: async ({ limit }) => {
        const settings = getSettings();
        const { winners, myMedianLikes, threshold } = myWinners(loadCorpus(), settings.outlierMultiplier);
        return {
          myMedianLikes,
          threshold,
          winners: winners.slice(0, limit).map((w) => ({
            ...compactPost(w.post),
            hook: w.hookText,
          })),
        };
      },
    }),

    getArchetypes: tool({
      description: 'Content archetypes clustered from the corpus, with how often the niche uses each versus the user.',
      inputSchema: z.object({ archetypeId: z.number().int().optional() }),
      execute: async ({ archetypeId }) => {
        if (archetypeId !== undefined) {
          return {
            posts: postsForArchetype(archetypeId, 15).map((r) => ({
              ...compactPost(r.post),
              distance: r.distance,
            })),
          };
        }
        return { archetypes: activeArchetypes().map((a) => ({ id: a.id, name: a.name, description: a.description, size: a.size })), crossTab: archetypeCrossTab() };
      },
    }),

    getDrafts: tool({
      description: 'Current drafts and their status.',
      inputSchema: z.object({
        status: z.enum(['draft', 'approved', 'scheduled', 'published', 'discarded', 'any']).default('any'),
        limit: z.number().int().min(1).max(20).default(10),
      }),
      execute: async ({ status, limit }) => {
        const rows = db().select().from(drafts).orderBy(desc(drafts.id)).all();
        const filtered = (status === 'any' ? rows : rows.filter((d) => d.status === status)).slice(0, limit);
        return {
          drafts: filtered.map((d) => ({
            id: d.id,
            format: d.format,
            title: d.title,
            hook: d.hook,
            status: d.status,
            generatedBy: d.generatedBy,
          })),
        };
      },
    }),

    createDraft: tool({
      description: 'Create a new draft. Use the same shape as generated drafts.',
      inputSchema: draftSchema,
      execute: async (input) => {
        const analysis = latestAnalysis();
        const id = insertDraft(input, analysis?.id ?? 0, 'chat');
        return { id, message: `Draft ${id} created.` };
      },
    }),

    editDraft: tool({
      description: 'Edit fields on an existing draft.',
      inputSchema: z.object({
        id: z.number().int(),
        title: z.string().optional(),
        hook: z.string().optional(),
        caption: z.string().optional(),
        cta: z.string().optional(),
        hashtags: z.array(z.string()).optional(),
        status: z.enum(['draft', 'approved', 'discarded']).optional(),
      }),
      execute: async ({ id, ...patch }) => {
        const existing = draftById(id);
        if (!existing) return { error: `Draft ${id} not found.` };
        const clean = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => v !== undefined),
        );
        if (Object.keys(clean).length === 0) return { error: 'Nothing to change.' };
        db()
          .update(drafts)
          .set({ ...clean, updatedAt: Math.floor(Date.now() / 1000) })
          .where(eq(drafts.id, id))
          .run();
        return { id, changed: Object.keys(clean) };
      },
    }),

    scheduleDraft: tool({
      description: 'Schedule a draft for a specific time (unix seconds).',
      inputSchema: z.object({ id: z.number().int(), scheduledFor: z.number().int() }),
      execute: async ({ id, scheduledFor }) => {
        const draft = draftById(id);
        if (!draft) return { error: `Draft ${id} not found.` };
        if (scheduledFor <= Math.floor(Date.now() / 1000)) {
          return { error: 'That time is in the past.' };
        }
        const scheduleId = scheduleDraft(id, scheduledFor, getSettings().publishingMode);
        return { scheduleId, message: `Draft ${id} scheduled.` };
      },
    }),

    updateVoiceProfile: tool({
      description: 'Update the voice profile. Creates a new version; the old one is kept.',
      inputSchema: z.object({
        markdown: z.string().min(20),
        fields: voiceFieldsSchema.partial().optional(),
      }),
      execute: async ({ markdown, fields }) => {
        const current = activeVoice();
        const merged = { ...(current?.fields ?? {}), ...(fields ?? {}) };
        const parsed = voiceFieldsSchema.safeParse(merged);
        if (!parsed.success) return { error: 'Voice fields did not validate.' };
        const id = saveVoice({
          markdown,
          fields: parsed.data,
          generatedBy: 'chat',
          editedByUser: true,
        });
        return { id, message: 'Voice profile updated.' };
      },
    }),

    triggerRescan: tool({
      description:
        'Re-scrape an account. THIS SPENDS SCRAPING CREDITS. Never call it without the user explicitly confirming in their most recent message.',
      inputSchema: z.object({
        accountId: z.number().int(),
        confirmed: z.boolean().describe('Must be true, and only after the user has said yes.'),
      }),
      execute: async ({ accountId, confirmed }) => {
        if (!confirmed) {
          const account = getAccount(accountId);
          return {
            error: 'Not confirmed.',
            message: `Rescanning @${account?.handle ?? accountId} spends Apify credits. Ask the user to confirm first.`,
          };
        }
        const account = getAccount(accountId);
        if (!account) return { error: `Account ${accountId} not found.` };
        options.onRescanRequest?.(accountId);
        const jobId = enqueue('scan_account', { accountId, limit: 100, incremental: true });
        return { jobId, message: `Queued a rescan of @${account.handle}.` };
      },
    }),

    listAccounts: tool({
      description: 'All accounts being tracked, mine and competitors, with their ids.',
      inputSchema: z.object({}),
      execute: async () => ({
        accounts: listAccounts().map((a) => ({
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
