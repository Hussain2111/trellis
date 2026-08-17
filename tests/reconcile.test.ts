import { describe, expect, it } from 'vitest';
import { describeIssues, pruneEvidence, reconcile } from '@/lib/analysis/reconcile';
import type { AggregateSnapshot } from '@/lib/analysis/aggregate';
import type { GapAnalysis, Pattern } from '@/lib/prompts/gap-analysis.v1';

const AGGREGATE = `
FORMAT MIX:
  reel: me 20% (n=30) | niche 51% (n=200)
  carousel: me 60% (n=90) | niche 22% (n=88)

MY WINNERS (post_id, likes, type, hook):
  101 | 5200 | reel | the setting nobody tells you about
  102 | 4100 | reel | three mistakes killing your reach
`;

const snapshot = {
  windowDays: 30,
  niche: 'photography',
  handle: 'me',
  myFollowers: 5000,
  counts: { mine: 120, niche: 288 },
  formats: [],
  traits: [],
  archetypes: [{ archetypeId: 7 }],
  decayed: [],
  winners: [
    { postId: 101, shortcode: 'A', likes: 5200, type: 'reel', hook: '' },
    { postId: 102, shortcode: 'B', likes: 4100, type: 'reel', hook: '' },
  ],
  cadence: [],
  pool: { accounts: [], totalPosts: 288, medianFollowers: 0, thin: false, warning: null },
  inputsHash: 'abc',
} as unknown as AggregateSnapshot;

function pattern(overrides: Partial<Pattern> = {}): Pattern {
  return {
    claim: 'Reels carry this niche and you are barely making them.',
    niche_stat: '51% of posts',
    my_stat: '20% of yours',
    delta: '31 points behind',
    evidence: [101],
    ...overrides,
  };
}

function analysis(overrides: Partial<GapAnalysis> = {}): GapAnalysis {
  return {
    patterns: [pattern(), pattern(), pattern(), pattern(), pattern()],
    gap: { ...pattern(), why_this_one: 'Because it is the largest and the most fixable of the five.' },
    ...overrides,
  };
}

describe('evidence reconciliation', () => {
  it('accepts claims whose numbers and receipts both check out', () => {
    const result = reconcile(analysis(), snapshot, AGGREGATE);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('rejects a claim with no receipts', () => {
    const bad = analysis({
      patterns: [pattern({ evidence: [] }), pattern(), pattern(), pattern(), pattern()],
    });
    const result = reconcile(bad, snapshot, AGGREGATE);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.problem).toContain('evidence is empty');
  });

  it('rejects post ids that were never in the aggregates', () => {
    const bad = analysis({
      patterns: [pattern({ evidence: [999] }), pattern(), pattern(), pattern(), pattern()],
    });
    const result = reconcile(bad, snapshot, AGGREGATE);
    expect(result.ok).toBe(false);
    expect(result.unknownEvidence).toContain(999);
  });

  it('rejects a statistic the model invented', () => {
    const bad = analysis({
      patterns: [
        pattern({ niche_stat: '87% of posts' }),
        pattern(),
        pattern(),
        pattern(),
        pattern(),
      ],
    });
    const result = reconcile(bad, snapshot, AGGREGATE);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.problem.includes('87%'))).toBe(true);
  });

  it('allows a qualitative stat with no number in it', () => {
    const soft = analysis({
      patterns: [
        pattern({ my_stat: 'almost never' }),
        pattern(),
        pattern(),
        pattern(),
        pattern(),
      ],
    });
    expect(reconcile(soft, snapshot, AGGREGATE).ok).toBe(true);
  });

  it('checks the gap as strictly as the patterns', () => {
    const bad = analysis();
    bad.gap.evidence = [4242];
    const result = reconcile(bad, snapshot, AGGREGATE);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.where === 'gap')).toBe(true);
  });

  it('notices the wrong number of patterns', () => {
    const bad = analysis({ patterns: [pattern(), pattern()] });
    const result = reconcile(bad, snapshot, AGGREGATE);
    expect(result.issues.some((i) => i.problem.includes('expected exactly 5'))).toBe(true);
  });

  it('turns issues into something a repair prompt can act on', () => {
    const bad = analysis({
      patterns: [pattern({ evidence: [] }), pattern(), pattern(), pattern(), pattern()],
    });
    const text = describeIssues(reconcile(bad, snapshot, AGGREGATE).issues);
    expect(text).toContain('pattern 1');
  });

  it('prunes unverifiable evidence rather than presenting it as fact', () => {
    const bad = analysis({
      patterns: [pattern({ evidence: [101, 999] }), pattern(), pattern(), pattern(), pattern()],
    });
    const pruned = pruneEvidence(bad, snapshot);
    expect(pruned.patterns[0]!.evidence).toEqual([101]);
  });
});
