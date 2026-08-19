import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { accounts, hookLabels, posts } from '../db/schema';
import { latestAnalysis } from '../analysis/analysis';
import type { Pattern } from '../analysis/patterns';
import { byFormat, median, postAnalytics } from './posts';

/**
 * Opportunities is the one screen that says "do this". Everything on it has to
 * survive the question "how do you know?", so each opportunity carries the
 * numbers it was derived from and the posts it was derived from.
 *
 * Three sources, deliberately different in kind:
 *
 *  - Pattern gaps come from the stored analysis (`analyses.patterns`) — what
 *    the niche's top performers do that you do less of.
 *  - Format gaps come from your own Graph insights — formats that reach further
 *    than your median but that you rarely post.
 *  - Hook gaps come from `hook_labels` — opening styles the niche uses that
 *    you have never used.
 *
 * v1 picked a single "biggest gap" and gave it a tab. That framing forced a
 * winner even when two things were tied, and hid everything else. This ranks
 * instead.
 */

export type OpportunityKind = 'pattern' | 'format' | 'hook';

export interface Opportunity {
  kind: OpportunityKind;
  title: string;
  /** The claim, with its own numbers in it. Never a bare adjective. */
  detail: string;
  /** 0..1 — how much of a gap this is, used only for ordering. */
  weight: number;
  nicheStat: number | null;
  myStat: number | null;
  sampleSize: number;
  /** Post ids backing the claim, so it can be checked. */
  receipts: number[];
}

export interface OpportunitiesResult {
  opportunities: Opportunity[];
  analysedAt: Date | null;
  /** Reasons a source produced nothing, so an empty screen explains itself. */
  notes: string[];
}

/** Below this, a share is being computed from too few posts to act on. */
const MIN_SAMPLE = 5;

export async function opportunities(): Promise<OpportunitiesResult> {
  const notes: string[] = [];
  const found: Opportunity[] = [];

  const [self] = await db().select().from(accounts).where(eq(accounts.role, 'self')).limit(1);
  if (!self) {
    return { opportunities: [], analysedAt: null, notes: ['No account is marked as yours yet.'] };
  }

  const analysis = await latestAnalysis();
  if (!analysis) {
    notes.push('No pattern analysis has run yet — the weekly niche pass produces it.');
  } else {
    found.push(
      ...patternOpportunities(analysis.patterns as (Pattern & { claim?: string })[], notes),
    );
  }

  found.push(...(await formatOpportunities(self.id, self.followers, notes)));
  found.push(...(await hookOpportunities(self.id, notes)));

  return {
    opportunities: found.sort((a, b) => b.weight - a.weight),
    analysedAt: analysis?.createdAt ?? null,
    notes,
  };
}

function patternOpportunities(
  patterns: (Pattern & { claim?: string })[],
  notes: string[],
): Opportunity[] {
  const usable = patterns.filter(
    (p) => p.nicheSampleSize >= MIN_SAMPLE && p.mySampleSize >= MIN_SAMPLE,
  );
  if (patterns.length > 0 && usable.length === 0) {
    notes.push(
      `Every pattern was computed from fewer than ${MIN_SAMPLE} posts on one side, which is too few to act on.`,
    );
  }

  return (
    usable
      // A negative delta means you already do it more than the niche does. That
      // is not an opportunity, and listing it as one would pad the screen.
      .filter((p) => p.deltaPct > 0)
      .map((p) => ({
        kind: 'pattern' as const,
        title: p.name,
        detail:
          p.claim ??
          `${(p.nicheStat * 100).toFixed(0)}% of top performers in your niche do this; you do it ${(p.myStat * 100).toFixed(0)}% of the time.`,
        weight: Math.min(1, p.deltaPct / 100),
        nicheStat: p.nicheStat,
        myStat: p.myStat,
        sampleSize: Math.min(p.nicheSampleSize, p.mySampleSize),
        receipts: p.nichePostIds.slice(0, 8),
      }))
  );
}

/**
 * Formats that reach further than your median but that you rarely post.
 * Needs Graph insights, so it stays quiet rather than guessing when the
 * account has none yet.
 */
async function formatOpportunities(
  accountId: number,
  followers: number | null,
  notes: string[],
): Promise<Opportunity[]> {
  const rows = await postAnalytics(accountId, followers, 200);
  const measured = rows.filter((r) => r.reach != null);
  if (measured.length < MIN_SAMPLE * 2) {
    notes.push(
      'Not enough posts carry Instagram reach yet to compare formats — the daily sync fills this in.',
    );
    return [];
  }

  const formats = byFormat(measured).filter((f) => f.count >= 2 && f.medianReach != null);
  if (formats.length < 2) return [];

  // The baseline is the median across your posts, not the median of the format
  // medians. With two formats the latter just picks the higher one, so the
  // better-reaching format could never clear its own bar.
  const overall = median(measured.map((r) => r.reach!));
  if (overall == null || overall <= 0) return [];

  const total = formats.reduce((n, f) => n + f.count, 0);

  return formats
    .filter((f) => f.medianReach! > overall * 1.25 && f.count / total < 0.3)
    .map((f) => ({
      kind: 'format' as const,
      title: `Post more ${f.type}s`,
      detail:
        `Your ${f.type}s reach a median of ${Math.round(f.medianReach!).toLocaleString()} against ` +
        `${Math.round(overall).toLocaleString()} for your typical post, but they are only ` +
        `${Math.round((f.count / total) * 100)}% of what you post (${f.count} of ${total} measured).`,
      weight: Math.min(1, (f.medianReach! / overall - 1) / 2),
      nicheStat: null,
      myStat: f.count / total,
      sampleSize: f.count,
      receipts: measured
        .filter((r) => r.post.type === f.type)
        .slice(0, 8)
        .map((r) => r.post.id),
    }));
}

/** Opening styles the niche uses that you have never used. */
async function hookOpportunities(accountId: number, notes: string[]): Promise<Opportunity[]> {
  const competitors = await db()
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.role, 'competitor'));
  if (competitors.length === 0) return [];

  const labelled = await db()
    .select({ category: hookLabels.category, accountId: posts.accountId, postId: posts.id })
    .from(hookLabels)
    .innerJoin(posts, eq(posts.id, hookLabels.postId));

  if (labelled.length === 0) {
    notes.push('No posts have been hook-classified yet.');
    return [];
  }

  const competitorIds = new Set(competitors.map((c) => c.id));
  const nicheCounts = new Map<string, number[]>();
  const mine = new Set<string>();
  let nicheTotal = 0;

  for (const row of labelled) {
    if (row.accountId === accountId) {
      mine.add(row.category);
    } else if (competitorIds.has(row.accountId)) {
      const list = nicheCounts.get(row.category) ?? [];
      list.push(row.postId);
      nicheCounts.set(row.category, list);
      nicheTotal++;
    }
  }

  if (nicheTotal < MIN_SAMPLE) return [];

  return [...nicheCounts.entries()]
    .filter(([category, ids]) => !mine.has(category) && ids.length >= MIN_SAMPLE)
    .map(([category, ids]) => ({
      kind: 'hook' as const,
      title: `Try a ${category.replace(/_/g, ' ')} opening`,
      detail:
        `${ids.length} of ${nicheTotal} classified posts in your niche open this way ` +
        `(${Math.round((ids.length / nicheTotal) * 100)}%). None of yours do.`,
      weight: Math.min(1, ids.length / nicheTotal),
      nicheStat: ids.length / nicheTotal,
      myStat: 0,
      sampleSize: ids.length,
      receipts: ids.slice(0, 8),
    }));
}
