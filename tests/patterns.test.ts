import { describe, expect, it } from 'vitest';
import {
  biggestGap,
  computePatterns,
  predicateForKey,
  type EnrichedPost,
} from '../lib/analysis/patterns';

let nextId = 1;
function post(overrides: Partial<EnrichedPost>): EnrichedPost {
  return {
    id: nextId++,
    role: 'competitor',
    type: 'reel',
    engagementRate: 0.05,
    postedHour: 12,
    hasCta: false,
    hasQuestion: false,
    hookCategory: 'other',
    ...overrides,
  };
}

describe('computePatterns', () => {
  it('is empty with no competitor or no self posts', () => {
    expect(computePatterns([post({ role: 'self' })])).toEqual([]);
    expect(computePatterns([post({ role: 'competitor' })])).toEqual([]);
  });

  it('measures "what works in the niche" only from the top quartile of competitor posts by engagement', () => {
    // 8 competitor posts: top 2 (engagementRate .5, .4) all have hasCta=true;
    // the bottom 6 don't. Only the top quartile should count toward nicheStat.
    const competitors = [
      post({ engagementRate: 0.5, hasCta: true }),
      post({ engagementRate: 0.4, hasCta: true }),
      ...Array.from({ length: 6 }, () => post({ engagementRate: 0.01, hasCta: false })),
    ];
    const selfPosts = [post({ role: 'self', hasCta: true }), post({ role: 'self', hasCta: false })];

    const patterns = computePatterns([...competitors, ...selfPosts]);
    const ctaPattern = patterns.find((p) => p.key === 'has_cta')!;
    expect(ctaPattern.nicheStat).toBe(1); // both top-quartile posts have CTA
    expect(ctaPattern.myStat).toBe(0.5);
    expect(ctaPattern.deltaPct).toBeCloseTo(50, 5);
  });

  it('tags every pattern with the post ids that actually exhibit the trait', () => {
    const winner = post({ engagementRate: 0.9, hasQuestion: true });
    const competitors = [
      winner,
      ...Array.from({ length: 3 }, () => post({ engagementRate: 0.01 })),
    ];
    const selfMatch = post({ role: 'self', hasQuestion: true });
    const selfNoMatch = post({ role: 'self', hasQuestion: false });

    const patterns = computePatterns([...competitors, selfMatch, selfNoMatch]);
    const questionPattern = patterns.find((p) => p.key === 'has_question')!;
    expect(questionPattern.nichePostIds).toEqual([winner.id]);
    expect(questionPattern.myPostIds).toEqual([selfMatch.id]);
  });

  it('ranks the returned patterns by absolute delta, largest first', () => {
    const competitors = [
      post({ engagementRate: 0.9, hasCta: true, hasQuestion: true }),
      ...Array.from({ length: 3 }, () =>
        post({ engagementRate: 0.01, hasCta: false, hasQuestion: false }),
      ),
    ];
    // Self never uses CTA (delta 100) but always asks a question (delta 0).
    const selfPosts = [
      post({ role: 'self', hasCta: false, hasQuestion: true }),
      post({ role: 'self', hasCta: false, hasQuestion: true }),
    ];
    const patterns = computePatterns([...competitors, ...selfPosts]);
    const ctaIndex = patterns.findIndex((p) => p.key === 'has_cta');
    const questionIndex = patterns.findIndex((p) => p.key === 'has_question');
    expect(ctaIndex).toBeLessThan(questionIndex);
  });

  it('returns at most 5 patterns', () => {
    const competitors = [post({ engagementRate: 0.9 }), post({ engagementRate: 0.8 })];
    const selfPosts = [post({ role: 'self' })];
    expect(computePatterns([...competitors, ...selfPosts]).length).toBeLessThanOrEqual(5);
  });
});

describe('biggestGap', () => {
  it('is the first (largest-delta) pattern', () => {
    const patterns = computePatterns([
      post({ engagementRate: 0.9, hasCta: true }),
      ...Array.from({ length: 3 }, () => post({ engagementRate: 0.01, hasCta: false })),
      post({ role: 'self', hasCta: false }),
    ]);
    expect(biggestGap(patterns)).toBe(patterns[0]);
  });

  it('is null for an empty pattern list', () => {
    expect(biggestGap([])).toBeNull();
  });
});

describe('predicateForKey', () => {
  it('resolves every key shape computePatterns can produce', () => {
    expect(predicateForKey('has_cta')(post({ hasCta: true }))).toBe(true);
    expect(predicateForKey('has_question')(post({ hasQuestion: true }))).toBe(true);
    expect(predicateForKey('hook:bold_claim')(post({ hookCategory: 'bold_claim' }))).toBe(true);
    expect(predicateForKey('hook:bold_claim')(post({ hookCategory: 'other' }))).toBe(false);
    expect(predicateForKey('format:reel')(post({ type: 'reel' }))).toBe(true);
    expect(predicateForKey('format:reel')(post({ type: 'carousel' }))).toBe(false);
  });

  it('resolves an hour bucket key to the same bucketing computePatterns uses', () => {
    const morning = post({ postedHour: 8 });
    const evening = post({ postedHour: 20 });
    expect(predicateForKey('hour:0')(morning)).toBe(true);
    expect(predicateForKey('hour:0')(evening)).toBe(false);
  });

  it('throws for an unrecognized key', () => {
    expect(() => predicateForKey('nonsense:foo')).toThrow();
  });
});
