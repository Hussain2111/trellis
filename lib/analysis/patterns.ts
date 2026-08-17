import { percentile, share } from './stats';

/**
 * Layer A/B boundary: a post enriched with everything the pattern engine
 * needs, independent of how it was loaded — keeps `computePatterns` pure and
 * directly unit-testable against hand-built fixtures, no database required.
 */
export interface EnrichedPost {
  id: number;
  role: 'self' | 'competitor';
  type: string;
  engagementRate: number | null;
  postedHour: number | null;
  hasCta: boolean;
  hasQuestion: boolean;
  hookCategory: string | null;
}

export interface Pattern {
  /** Machine key — also how `reconcilePatterns` re-derives the predicate. */
  key: string;
  name: string;
  /** 0..1 share of top-performing niche posts exhibiting this trait. */
  nicheStat: number;
  /** 0..1 share of the account's own posts exhibiting this trait. */
  myStat: number;
  /** (nicheStat - myStat) * 100 — positive means the niche does it more. */
  deltaPct: number;
  /** The specific niche posts that exhibit the trait — the numerator, not the denominator. */
  nichePostIds: number[];
  /** The specific self posts that exhibit the trait. */
  myPostIds: number[];
  nicheSampleSize: number;
  mySampleSize: number;
}

export interface Gap extends Pattern {
  claim: string;
}

const HOUR_BUCKETS: [number, number, string][] = [
  [6, 10, 'morning (6–10)'],
  [10, 14, 'midday (10–14)'],
  [14, 18, 'afternoon (14–18)'],
  [18, 22, 'evening (18–22)'],
  [22, 6, 'late night (22–6)'],
];

function hourBucketKey(hour: number): string {
  return HOUR_BUCKETS.findIndex(([start, end]) =>
    start < end ? hour >= start && hour < end : hour >= start || hour < end,
  ).toString();
}

/** Resolves a pattern's `key` back to the predicate that produced it — the single source of truth for reconciliation. */
export function predicateForKey(key: string): (post: EnrichedPost) => boolean {
  if (key === 'has_cta') return (p) => p.hasCta;
  if (key === 'has_question') return (p) => p.hasQuestion;
  if (key.startsWith('hook:')) {
    const category = key.slice('hook:'.length);
    return (p) => p.hookCategory === category;
  }
  if (key.startsWith('format:')) {
    const type = key.slice('format:'.length);
    return (p) => p.type === type;
  }
  if (key.startsWith('hour:')) {
    const bucketKey = key.slice('hour:'.length);
    return (p) => p.postedHour !== null && hourBucketKey(p.postedHour) === bucketKey;
  }
  throw new Error(`unknown pattern key "${key}"`);
}

function countBy<T>(items: T[], keyOf: (item: T) => string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function mostCommon(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function buildPattern(
  key: string,
  name: string,
  nichePool: EnrichedPost[],
  myPool: EnrichedPost[],
): Pattern {
  const predicate = predicateForKey(key);
  const nicheMatches = nichePool.filter(predicate);
  const myMatches = myPool.filter(predicate);
  const nicheStat = share(nicheMatches.length, nichePool.length);
  const myStat = share(myMatches.length, myPool.length);
  return {
    key,
    name,
    nicheStat,
    myStat,
    deltaPct: (nicheStat - myStat) * 100,
    nichePostIds: nicheMatches.map((p) => p.id),
    myPostIds: myMatches.map((p) => p.id),
    nicheSampleSize: nichePool.length,
    mySampleSize: myPool.length,
  };
}

/**
 * The 5 patterns that win in the niche, ranked by how large the gap to this
 * account is — exactly what the spec asks for: "identify 5 patterns that win
 * in the niche... the pattern with the largest delta" is patterns[0].
 *
 * "What works in the niche" is measured on the *top quartile* of competitor
 * posts by engagement rate — the account's own posts are never used to
 * define what "winning" looks like, only to measure how far it is from that.
 */
export function computePatterns(corpus: EnrichedPost[]): Pattern[] {
  const competitorPosts = corpus.filter(
    (p) => p.role === 'competitor' && p.engagementRate !== null,
  );
  const selfPosts = corpus.filter((p) => p.role === 'self');

  if (competitorPosts.length === 0 || selfPosts.length === 0) return [];

  const threshold = percentile(
    competitorPosts.map((p) => p.engagementRate!),
    0.75,
  );
  const topPerformers = competitorPosts.filter((p) => p.engagementRate! >= threshold);
  if (topPerformers.length === 0) return [];

  const candidates: Pattern[] = [];

  const hookCounts = countBy(topPerformers, (p) => p.hookCategory);
  const topHook = mostCommon(hookCounts);
  if (topHook) {
    candidates.push(
      buildPattern(
        `hook:${topHook}`,
        `"${topHook.replace(/_/g, ' ')}" hook among top performers`,
        topPerformers,
        selfPosts,
      ),
    );
  }

  const formatCounts = countBy(topPerformers, (p) => p.type);
  const topFormat = mostCommon(formatCounts);
  if (topFormat) {
    candidates.push(
      buildPattern(
        `format:${topFormat}`,
        `${topFormat} format among top performers`,
        topPerformers,
        selfPosts,
      ),
    );
  }

  const hourCounts = countBy(topPerformers, (p) =>
    p.postedHour !== null ? hourBucketKey(p.postedHour) : null,
  );
  const topHourBucket = mostCommon(hourCounts);
  if (topHourBucket !== null) {
    const label = HOUR_BUCKETS[Number(topHourBucket)]![2];
    candidates.push(
      buildPattern(
        `hour:${topHourBucket}`,
        `posting in the ${label} window among top performers`,
        topPerformers,
        selfPosts,
      ),
    );
  }

  candidates.push(
    buildPattern('has_cta', 'a call-to-action among top performers', topPerformers, selfPosts),
  );
  candidates.push(
    buildPattern('has_question', 'a question hook among top performers', topPerformers, selfPosts),
  );

  return candidates.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct)).slice(0, 5);
}

/** The single biggest gap — the pattern with the largest delta, per the spec. */
export function biggestGap(patterns: Pattern[]): Pattern | null {
  return patterns[0] ?? null;
}
