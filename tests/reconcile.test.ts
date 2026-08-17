import { describe, expect, it } from 'vitest';
import { computePatterns, type EnrichedPost } from '../lib/analysis/patterns';
import { reconcilePatterns } from '../lib/analysis/reconcile';

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

function corpus(): {
  corpus: EnrichedPost[];
  competitors: EnrichedPost[];
  selfPosts: EnrichedPost[];
} {
  const competitors = [
    post({ engagementRate: 0.9, hasCta: true, hasQuestion: true }),
    ...Array.from({ length: 3 }, () =>
      post({ engagementRate: 0.01, hasCta: false, hasQuestion: false }),
    ),
  ];
  const selfPosts = [post({ role: 'self', hasCta: false }), post({ role: 'self', hasCta: true })];
  return { corpus: [...competitors, ...selfPosts], competitors, selfPosts };
}

describe('reconcilePatterns', () => {
  it('finds no issues in a genuinely computed pattern set', () => {
    const { corpus: full } = corpus();
    const patterns = computePatterns(full);
    expect(reconcilePatterns(patterns, full)).toEqual([]);
  });

  it('flags a post id that is not in the corpus', () => {
    const { corpus: full } = corpus();
    const patterns = computePatterns(full);
    const tampered = patterns.map((p) =>
      p.key === 'has_cta' ? { ...p, nichePostIds: [...p.nichePostIds, 999_999] } : p,
    );
    const issues = reconcilePatterns(tampered, full);
    expect(issues.some((i) => i.reason.includes('not in the corpus'))).toBe(true);
  });

  it('flags a post id that does not satisfy the pattern predicate', () => {
    const { corpus: full, selfPosts } = corpus();
    const patterns = computePatterns(full);
    // Claim a self post that does NOT have a CTA as evidence for the has_cta pattern.
    const nonCtaSelfPost = selfPosts.find((p) => !p.hasCta)!;
    const tampered = patterns.map((p) =>
      p.key === 'has_cta' ? { ...p, myPostIds: [nonCtaSelfPost.id] } : p,
    );
    const issues = reconcilePatterns(tampered, full);
    expect(issues.some((i) => i.reason.includes('does not satisfy'))).toBe(true);
  });

  it('flags a stat that does not match its recomputed value', () => {
    const { corpus: full } = corpus();
    const patterns = computePatterns(full);
    const tampered = patterns.map((p) => (p.key === 'has_cta' ? { ...p, nicheStat: 0.01 } : p));
    const issues = reconcilePatterns(tampered, full);
    expect(issues.some((i) => i.reason.includes('recomputes to'))).toBe(true);
  });

  it('rejects an unknown pattern key rather than silently passing', () => {
    const { corpus: full } = corpus();
    const patterns = computePatterns(full);
    const tampered = patterns.map((p) => (p.key === 'has_cta' ? { ...p, key: 'made_up_key' } : p));
    const issues = reconcilePatterns(tampered, full);
    expect(issues.some((i) => i.patternKey === 'made_up_key')).toBe(true);
  });
});
