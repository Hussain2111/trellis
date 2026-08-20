import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { accounts } from '../db/schema';
import { latestAnalysis } from '../analysis/analysis';
import type { Pattern } from '../analysis/patterns';
import { byFormat, postAnalytics, summarise } from '../analytics/posts';
import { opportunities as deterministicOpportunities } from '../analytics/opportunities';
import { hooksAmongIdeas, ideas } from '../analytics/ideas';
import { hotTopics } from '../analytics/topics';
import { weeklyReport } from '../analytics/weekly';
import { followerHistory } from '../insights/followers';
import { riyadhDay, startOfWeekRiyadh } from '../time';

/**
 * Assembles the JSON handed to Gemini. Every figure in here was computed by
 * SQL — this module reuses the analytics queries wholesale rather than
 * recomputing anything.
 *
 * Sample floors are applied *here*, before the call. A model cannot caveat its
 * way around thin data that never reached it, and asking it to notice thin
 * data is asking it to be reliable about exactly the thing it is worst at.
 */

/** A format with fewer posts than this never enters a payload. */
export const MIN_FORMAT_SAMPLE = 3;
/** Below this many measured posts there is nothing worth interpreting at all. */
export const MIN_MEASURED_POSTS = 5;

export interface PayloadPost {
  postId: number;
  type: string;
  postedOn: string | null;
  reach: number | null;
  saves: number | null;
  shares: number | null;
  interactions: number | null;
  engagementOnReach: number | null;
  hookCategory?: string | null;
  caption: string | null;
}

export interface OpportunitiesPayload {
  kind: 'opportunities';
  weekStart: string;
  account: { handle: string; followers: number | null; niche: string | null };
  /** Null when there is not enough measured data to say anything. */
  insufficient: string | null;
  ownPosts: PayloadPost[];
  baseline: {
    measuredPosts: number;
    unmeasuredPosts: number;
    medianReach: number | null;
    medianEngagementOnReach: number | null;
  };
  formats: { type: string; count: number; medianReach: number | null }[];
  patterns: {
    name: string;
    nichePct: number;
    yoursPct: number;
    deltaPct: number;
    nicheSample: number;
    yourSample: number;
    postIds: number[];
  }[];
  deterministic: { title: string; detail: string; postIds: number[] }[];
}

function trim(caption: string | null): string | null {
  return caption ? caption.replace(/\s+/g, ' ').slice(0, 180) : null;
}

export async function buildOpportunitiesPayload(
  now: Date = new Date(),
): Promise<OpportunitiesPayload | null> {
  const [self] = await db().select().from(accounts).where(eq(accounts.role, 'self')).limit(1);
  if (!self) return null;

  const weekStart = riyadhDay(startOfWeekRiyadh(now));
  const rows = await postAnalytics(self.id, self.followers, 100);
  const summary = summarise(rows);
  const measured = rows.filter((r) => r.reach != null);

  const deterministic = await deterministicOpportunities();

  const base: OpportunitiesPayload = {
    kind: 'opportunities',
    weekStart,
    account: { handle: self.handle, followers: self.followers, niche: self.niche },
    insufficient:
      measured.length < MIN_MEASURED_POSTS
        ? `Only ${measured.length} post(s) carry Instagram insights; ${MIN_MEASURED_POSTS} is the floor for interpreting them.`
        : null,
    ownPosts: [],
    baseline: {
      measuredPosts: summary.measured,
      unmeasuredPosts: summary.unmeasured,
      medianReach: summary.medianReach,
      medianEngagementOnReach: summary.medianEngagementOnReach,
    },
    formats: [],
    patterns: [],
    deterministic: deterministic.opportunities.map((o) => ({
      title: o.title,
      detail: o.detail,
      postIds: o.receipts,
    })),
  };

  if (base.insufficient) return base;

  base.ownPosts = measured.slice(0, 40).map((r) => ({
    postId: r.post.id,
    type: r.post.type,
    postedOn: r.post.takenAt ? riyadhDay(r.post.takenAt) : null,
    reach: r.reach,
    saves: r.saves,
    shares: r.shares,
    interactions: r.totalInteractions,
    engagementOnReach: r.engagementOnReach,
    caption: trim(r.post.caption),
  }));

  // Sample floor applied in SQL-derived data, not asked of the model.
  base.formats = byFormat(measured)
    .filter((f) => f.count >= MIN_FORMAT_SAMPLE)
    .map((f) => ({ type: f.type, count: f.count, medianReach: f.medianReach }));

  const analysis = await latestAnalysis();
  if (analysis) {
    const patterns = analysis.patterns as (Pattern & { claim?: string })[];
    base.patterns = patterns
      .filter(
        (p) => p.nicheSampleSize >= MIN_MEASURED_POSTS && p.mySampleSize >= MIN_MEASURED_POSTS,
      )
      .map((p) => ({
        name: p.name,
        nichePct: Math.round(p.nicheStat * 100),
        yoursPct: Math.round(p.myStat * 100),
        deltaPct: Math.round(p.deltaPct),
        nicheSample: p.nicheSampleSize,
        yourSample: p.mySampleSize,
        postIds: p.nichePostIds.slice(0, 8),
      }));
  }

  return base;
}

export interface WeeklyPayload {
  kind: 'weekly';
  weekStart: string;
  weekLabel: string;
  account: { handle: string; followers: number | null; niche: string | null };
  insufficient: string | null;
  recap: {
    metrics: {
      label: string;
      value: number | null;
      previous: number | null;
      change: number | null;
    }[];
    planned: number;
    posted: number;
    missed: number;
    bestPost: PayloadPost | null;
    worstPost: PayloadPost | null;
    followerHistory: { day: string; followerCount: number | null; change: number | null }[];
    notes: string[];
  };
  trends: {
    competitorBreakouts: {
      postId: number;
      handle: string;
      viralScore: number;
      baseline: number;
      engagement: number;
      hookCategory: string | null;
      caption: string | null;
    }[];
    hookCategories: { category: string; count: number }[];
    risingTopics: {
      tag: string;
      recentPosts: number;
      priorPosts: number;
      shareDeltaPct: number | null;
    }[];
    poolMedianEngagement: number | null;
  };
}

export async function buildWeeklyPayload(now: Date = new Date()): Promise<WeeklyPayload | null> {
  const [self] = await db().select().from(accounts).where(eq(accounts.role, 'self')).limit(1);
  if (!self) return null;

  const report = await weeklyReport(now);
  const weekStart = riyadhDay(startOfWeekRiyadh(now));

  const rows = await postAnalytics(self.id, self.followers, 100);
  const weekPosts = rows.filter(
    (r) => r.post.takenAt && riyadhDay(startOfWeekRiyadh(r.post.takenAt)) === weekStart,
  );
  const ranked = [...weekPosts].sort(
    (a, b) => (b.reach ?? b.totalInteractions ?? 0) - (a.reach ?? a.totalInteractions ?? 0),
  );

  const toPayloadPost = (r: (typeof rows)[number] | undefined): PayloadPost | null =>
    r
      ? {
          postId: r.post.id,
          type: r.post.type,
          postedOn: r.post.takenAt ? riyadhDay(r.post.takenAt) : null,
          reach: r.reach,
          saves: r.saves,
          shares: r.shares,
          interactions: r.totalInteractions,
          engagementOnReach: r.engagementOnReach,
          caption: trim(r.post.caption),
        }
      : null;

  const { ideas: breakouts } = await ideas({ windowDays: 14, limit: 8 });
  const topics = await hotTopics({ windowDays: 14, limit: 8 });
  const followers = await followerHistory(14);

  return {
    kind: 'weekly',
    weekStart,
    weekLabel: report.weekLabel,
    account: { handle: self.handle, followers: self.followers, niche: self.niche },
    insufficient:
      weekPosts.length === 0 && breakouts.length === 0
        ? 'Nothing was published this week and the niche produced no breakouts, so there is nothing to read.'
        : null,
    recap: {
      metrics: report.metrics.map((m) => ({
        label: m.label,
        value: m.value,
        previous: m.previous,
        change: m.change,
      })),
      planned: report.planned,
      posted: report.posted,
      missed: report.missed,
      bestPost: toPayloadPost(ranked[0]),
      // Only meaningful with more than one post — otherwise best and worst are
      // the same row, which reads as a finding and is not one.
      worstPost: ranked.length > 1 ? toPayloadPost(ranked.at(-1)) : null,
      followerHistory: followers.map((f) => ({
        day: f.day,
        followerCount: f.followerCount,
        change: f.change,
      })),
      notes: report.notes,
    },
    trends: {
      competitorBreakouts: breakouts.map((b) => ({
        postId: b.post.id,
        handle: b.handle,
        viralScore: Number(b.viralScore.toFixed(1)),
        baseline: Math.round(b.baseline),
        engagement: b.engagement,
        hookCategory: b.hookCategory,
        caption: trim(b.post.caption),
      })),
      hookCategories: hooksAmongIdeas(breakouts),
      risingTopics: topics.rising.map((t) => ({
        tag: t.tag,
        recentPosts: t.recentPosts,
        priorPosts: t.priorPosts,
        shareDeltaPct: t.shareDeltaPct == null ? null : Number(t.shareDeltaPct.toFixed(1)),
      })),
      poolMedianEngagement: topics.poolMedianEngagement,
    },
  };
}
