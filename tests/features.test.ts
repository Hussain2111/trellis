import { describe, expect, it } from 'vitest';
import {
  cadenceByWeek,
  computeFeatures,
  engagementRate,
  firstLine,
  hookText,
  markOutliers,
  summariseByFormat,
} from '@/lib/analysis/features';
import { median, percentile, robustZ, trailingMedian } from '@/lib/analysis/stats';
import type { Post } from '@/lib/db/schema';

const DAY = 86400;
const nowS = Math.floor(Date.now() / 1000);

function post(overrides: Partial<Post> = {}): Post {
  return {
    id: 1,
    accountId: 1,
    shortcode: 'ABC',
    type: 'reel',
    caption: null,
    takenAt: nowS,
    likes: 100,
    comments: 4,
    views: null,
    plays: null,
    durationS: null,
    carouselCount: null,
    thumbnailUrl: null,
    mediaUrls: [],
    isSponsored: false,
    raw: {},
    firstSeenAt: nowS,
    lastSeenAt: nowS,
    ...overrides,
  } as Post;
}

describe('stats', () => {
  it('handles even and odd medians, and empty input', () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('interpolates percentiles', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
  });

  it('uses a robust z-score so one hit does not inflate the baseline', () => {
    // A single 100k outlier would drag a mean-based z toward zero for
    // everything else; the median/MAD version keeps it visible.
    const values = [100, 110, 95, 105, 100, 100000];
    expect(robustZ(100000, values)).toBeGreaterThan(10);
    expect(Math.abs(robustZ(105, values))).toBeLessThan(2);
  });

  it('computes a trailing median over the preceding window only', () => {
    const values = [10, 20, 30, 40, 1000];
    expect(trailingMedian(values, 4, 4)).toBe(25);
  });
});

describe('caption features', () => {
  it('takes the first non-empty line as the hook', () => {
    expect(firstLine('\n\n  The real hook  \nrest')).toBe('The real hook');
    expect(firstLine(null)).toBe('');
  });

  it('strips hashtag walls and mentions from the hook', () => {
    expect(hookText('#tips #photo Real hook here @someone')).toBe('Real hook here');
  });

  it('puts the spoken hook first when a reel was transcribed', () => {
    expect(hookText('Caption opener', 'Nobody tells you this')).toBe(
      'Nobody tells you this — Caption opener',
    );
  });

  it('counts hashtags, mentions and emoji including ZWJ sequences', () => {
    const f = computeFeatures(
      post({ caption: 'Look 👨‍👩‍👧 at this 🔥 #one #two @me @you' }),
      1000,
    );
    expect(f.hashtagCount).toBe(2);
    expect(f.mentionCount).toBe(2);
    // The family emoji is one grapheme but several pictographic code points;
    // what matters is that emoji are detected at all, not the exact tally.
    expect(f.emojiCount).toBeGreaterThanOrEqual(2);
  });

  it('detects a CTA conservatively', () => {
    expect(computeFeatures(post({ caption: 'Comment YES below' }), 100).hasCta).toBe(true);
    expect(computeFeatures(post({ caption: 'Link in bio' }), 100).hasCta).toBe(true);
    expect(computeFeatures(post({ caption: 'Save this for later' }), 100).hasCta).toBe(true);
    // A false positive here quietly corrupts a benchmark claim.
    expect(computeFeatures(post({ caption: 'I commented on the weather' }), 100).hasCta).toBe(false);
  });

  it('detects a question in the opening only', () => {
    expect(computeFeatures(post({ caption: 'Ever wondered why?' }), 100).hasQuestion).toBe(true);
    expect(
      computeFeatures(post({ caption: `${'x'.repeat(400)}\nwhy?` }), 100).hasQuestion,
    ).toBe(false);
  });
});

describe('engagement normalisation', () => {
  it('normalises by follower count, so account size cancels out', () => {
    const small = engagementRate(post({ likes: 400, comments: 20 }), 5_000);
    const large = engagementRate(post({ likes: 2_000, comments: 100 }), 200_000);
    expect(small).toBeCloseTo(0.084);
    expect(large).toBeCloseTo(0.0105);
    expect(small!).toBeGreaterThan(large!);
  });

  it('returns null rather than a fake number when followers are unknown', () => {
    expect(engagementRate(post(), null)).toBeNull();
    expect(engagementRate(post(), 0)).toBeNull();
  });
});

describe('outlier detection', () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    post({
      id: i + 1,
      takenAt: nowS - (30 - i) * 2 * DAY,
      likes: i === 20 ? 5000 : 100 + (i % 5) * 10,
    }),
  ).map((p) => ({ post: p, engagementRate: 0.02 }));

  it('flags a post far above its trailing median', () => {
    const result = markOutliers(rows, 2.5);
    expect(result.get(21)?.isOutlier).toBe(true);
  });

  it('does not flag ordinary posts', () => {
    const result = markOutliers(rows, 2.5);
    const flagged = [...result.values()].filter((r) => r.isOutlier);
    expect(flagged).toHaveLength(1);
  });

  it('refuses to call anything an outlier before there is history', () => {
    const early = rows.slice(0, 4);
    const result = markOutliers(early, 2.5);
    expect([...result.values()].every((r) => !r.isOutlier)).toBe(true);
  });
});

describe('cadence and format summaries', () => {
  it('buckets posts into weeks and ignores anything older than the window', () => {
    const rows = [
      post({ id: 1, takenAt: nowS - 2 * DAY }),
      post({ id: 2, takenAt: nowS - 3 * DAY }),
      post({ id: 3, takenAt: nowS - 400 * DAY }),
    ];
    const buckets = cadenceByWeek(rows, 12);
    expect(buckets).toHaveLength(12);
    expect(buckets.reduce((sum, b) => sum + b.total, 0)).toBe(2);
  });

  it('summarises per format with medians, not means', () => {
    const rows = [
      post({ id: 1, type: 'reel', likes: 100 }),
      post({ id: 2, type: 'reel', likes: 100 }),
      post({ id: 3, type: 'reel', likes: 100000 }),
      post({ id: 4, type: 'carousel', likes: 50 }),
    ];
    const summary = summariseByFormat(rows, 1000);
    const reel = summary.find((s) => s.type === 'reel')!;
    expect(reel.count).toBe(3);
    expect(reel.medianLikes).toBe(100);
  });
});
