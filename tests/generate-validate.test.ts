import { describe, expect, it } from 'vitest';
import {
  allowedNumbers,
  numbersIn,
  postIdsIn,
  unbackedNumbers,
  validateInsights,
} from '../lib/generate/validate';

/**
 * This is the guard that makes "SQL computes, Gemini interprets" a guarantee
 * rather than an intention. If it is wrong, a fabricated statistic reaches the
 * screen wearing the same styling as a real one — so it gets tested against
 * the ways a model actually writes numbers, not just the easy cases.
 */

const payload = {
  baseline: { medianReach: 3241.5, medianEngagementOnReach: 0.0412, measuredPosts: 24 },
  formats: [{ type: 'reel', count: 7, medianReach: 5120 }],
  ownPosts: [
    { postId: 11, reach: 5120, saves: 88 },
    { postId: 12, reach: 900, saves: 4 },
  ],
};

describe('allowedNumbers', () => {
  it('accepts the roundings a model legitimately produces from a payload figure', () => {
    const allowed = allowedNumbers(payload);
    // 3241.5 written as-is, floored, or rounded — all the same underlying figure.
    expect(unbackedNumbers('median reach 3241.5', allowed)).toEqual([]);
    expect(unbackedNumbers('median reach 3241', allowed)).toEqual([]);
    expect(unbackedNumbers('median reach 3242', allowed)).toEqual([]);
  });

  it('accepts a 0..1 ratio written as a percentage', () => {
    const allowed = allowedNumbers(payload);
    expect(unbackedNumbers('engagement of 4.1%', allowed)).toEqual([]);
    expect(unbackedNumbers('engagement of 4%', allowed)).toEqual([]);
  });

  it('reads a thousands separator as one number, not two', () => {
    const allowed = allowedNumbers(payload);
    expect(numbersIn('reach was 5,120')).toEqual([5120]);
    expect(unbackedNumbers('reach was 5,120', allowed)).toEqual([]);
  });

  it('rejects a number that is merely plausible', () => {
    const allowed = allowedNumbers(payload);
    // Nothing in the payload says 3,900. This is the whole point.
    expect(unbackedNumbers('median reach is about 3900', allowed)).toEqual([3900]);
    expect(unbackedNumbers('you averaged 47 saves', allowed)).toEqual([47]);
  });

  it('rejects an arithmetically-correct number that was never computed in SQL', () => {
    const allowed = allowedNumbers(payload);
    // 5120 - 900 = 4220. True, and still not allowed: SQL did not compute it,
    // so nothing on the page can be traced back to a query.
    expect(unbackedNumbers('a gap of 4220 between them', allowed)).toEqual([4220]);
  });

  it('ignores small structural integers', () => {
    const allowed = allowedNumbers(payload);
    expect(unbackedNumbers('there are 3 things to try', allowed)).toEqual([]);
  });
});

describe('postIdsIn', () => {
  it('finds ids under postId, id, and postIds', () => {
    const ids = postIdsIn({
      ownPosts: [{ postId: 11 }, { postId: 12 }],
      patterns: [{ postIds: [30, 31] }],
    });
    expect(ids).toContain(11);
    expect(ids).toContain(30);
    expect(ids).toContain(31);
  });
});

interface Insight {
  finding: string;
  action: string;
  postIds: number[];
}

const extract = (i: Insight) => ({ prose: [i.finding, i.action], postIds: i.postIds });

describe('validateInsights', () => {
  it('keeps an insight whose every figure is in the payload', () => {
    const result = validateInsights<Insight>(
      [
        {
          finding: 'Your reels reach a median of 5120 against 3241.5 overall.',
          action: 'Post more reels.',
          postIds: [11],
        },
      ],
      payload,
      extract,
    );
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it('drops an insight that invents a figure, and says which', () => {
    const result = validateInsights<Insight>(
      [{ finding: 'Your reels reach 7400 on average.', action: 'Do more.', postIds: [11] }],
      payload,
      extract,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.dropped[0]!.reason).toMatch(/7400/);
  });

  it('checks the action text too, not just the finding', () => {
    const result = validateInsights<Insight>(
      [
        {
          finding: 'Reels do well.',
          action: 'Aim for 12000 reach next week.',
          postIds: [11],
        },
      ],
      payload,
      extract,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.dropped[0]!.reason).toMatch(/12000/);
  });

  it('drops an insight citing a post that is not in the payload', () => {
    const result = validateInsights<Insight>(
      [{ finding: 'This one did well.', action: 'Repeat it.', postIds: [999] }],
      payload,
      extract,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.dropped[0]!.reason).toMatch(/999/);
  });

  it('drops an uncited insight when citations are required', () => {
    const result = validateInsights<Insight>(
      [{ finding: 'Things are going well.', action: 'Keep going.', postIds: [] }],
      payload,
      extract,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.dropped[0]!.reason).toMatch(/cites no posts/);
  });

  it('allows an uncited claim when citations are optional, as for weekly prose', () => {
    const result = validateInsights<Insight>(
      [{ finding: 'A quiet week overall.', action: 'Post something.', postIds: [] }],
      payload,
      extract,
      { requireCitations: false },
    );
    expect(result.kept).toHaveLength(1);
  });

  it('drops only the bad insight, keeping the good ones', () => {
    const result = validateInsights<Insight>(
      [
        { finding: 'Reels reach 5120.', action: 'More reels.', postIds: [11] },
        { finding: 'Carousels reach 6000.', action: 'More carousels.', postIds: [12] },
        { finding: 'You measured 24 posts.', action: 'Keep syncing.', postIds: [11, 12] },
      ],
      payload,
      extract,
    );
    expect(result.kept).toHaveLength(2);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.item.finding).toMatch(/6000/);
  });

  it('lets prose with no numbers at all through', () => {
    const result = validateInsights<Insight>(
      [
        {
          finding: 'Your carousels consistently outperform your images.',
          action: 'Lean into carousels.',
          postIds: [11],
        },
      ],
      payload,
      extract,
    );
    expect(result.kept).toHaveLength(1);
  });
});
