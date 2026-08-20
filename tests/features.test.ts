import { describe, expect, it } from 'vitest';
import { computeFeatures, engagementRate, hookText, markOutliers } from '../lib/analysis/features';
import type { Post } from '../lib/db/schema';

let nextId = 1;
function post(overrides: Partial<Post>): Post {
  return {
    id: nextId++,
    accountId: 1,
    shortcode: `S${nextId}`,
    type: 'reel',
    caption: null,
    takenAt: new Date('2026-06-01T14:00:00Z'),
    likes: 100,
    comments: 10,
    views: null,
    plays: null,
    durationS: null,
    carouselCount: null,
    thumbnailUrl: null,
    mediaUrls: null,
    isSponsored: false,
    source: 'apify',
    igMediaId: null,
    permalink: null,
    raw: {},
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    ...overrides,
  };
}

describe('hookText', () => {
  it('strips hashtags and mentions from the first line', () => {
    expect(hookText('Big news today! #excited @friend\n\nMore text')).toBe('Big news today!');
  });

  it('is empty for an empty caption', () => {
    expect(hookText(null)).toBe('');
    expect(hookText('')).toBe('');
  });
});

describe('computeFeatures', () => {
  it('detects a question in the first line', () => {
    const f = computeFeatures(post({ caption: 'Ever wonder why this works?\n\nBody text.' }), 1000);
    expect(f.hasQuestion).toBe(true);
  });

  it('detects a call-to-action', () => {
    const f = computeFeatures(
      post({ caption: 'Great tip today.\n\nComment "yes" below to get the guide.' }),
      1000,
    );
    expect(f.hasCta).toBe(true);
  });

  it('does not false-positive a CTA on an ordinary caption', () => {
    const f = computeFeatures(post({ caption: 'Just a normal caption about my day.' }), 1000);
    expect(f.hasCta).toBe(false);
  });

  it('counts hashtags, mentions, and emoji', () => {
    const f = computeFeatures(post({ caption: 'Hi @friend! 🎉🔥 #fun #times' }), 1000);
    expect(f.hashtagCount).toBe(2);
    expect(f.mentionCount).toBe(1);
    expect(f.emojiCount).toBe(2);
  });

  it('reads the posted hour and day of week in UTC from takenAt', () => {
    const f = computeFeatures(post({ takenAt: new Date('2026-06-01T14:30:00Z') }), 1000);
    expect(f.postedHour).toBe(14);
    expect(f.postedDow).toBe(1); // Monday
  });

  it('is null for postedHour/postedDow when there is no takenAt', () => {
    const f = computeFeatures(post({ takenAt: null }), 1000);
    expect(f.postedHour).toBeNull();
    expect(f.postedDow).toBeNull();
  });
});

describe('engagementRate', () => {
  it('normalizes likes+comments by followers', () => {
    expect(engagementRate(post({ likes: 100, comments: 20 }), 1000)).toBeCloseTo(0.12, 5);
  });

  it('is null with no follower count', () => {
    expect(engagementRate(post({}), null)).toBeNull();
    expect(engagementRate(post({}), 0)).toBeNull();
  });
});

describe('markOutliers', () => {
  it('flags a post well above its trailing median as an outlier', () => {
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    const day = 86_400_000;
    const rows = Array.from({ length: 10 }, (_, i) =>
      post({ id: i + 1, likes: 100, takenAt: new Date(base + i * day) }),
    );
    // The 11th post, well above the trailing median of 100.
    rows.push(post({ id: 11, likes: 5000, takenAt: new Date(base + 10 * day) }));

    const result = markOutliers(
      rows.map((r) => ({ post: r, engagementRate: null })),
      3,
    );
    expect(result.get(11)?.isOutlier).toBe(true);
    expect(result.get(1)?.isOutlier).toBe(false);
  });

  it('never flags anything before there is enough trailing history', () => {
    const rows = Array.from({ length: 3 }, (_, i) => post({ id: i + 1, likes: 100 * (i + 1) }));
    const result = markOutliers(
      rows.map((r) => ({ post: r, engagementRate: null })),
      2,
    );
    for (const row of rows) expect(result.get(row.id)?.isOutlier).toBe(false);
  });
});
