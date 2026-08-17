import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropTempDb, useTempDb } from './helpers';
import { db } from '@/lib/db/client';
import { archetypes, postFeatures, postLabels, posts } from '@/lib/db/schema';
import { detectDecay } from '@/lib/analysis/aggregate';
import { upsertAccount } from '@/lib/ingest/upsert';
import { toBlob } from '@/lib/analysis/vector';

const DAY = 86400;
const nowS = Math.floor(Date.now() / 1000);

/**
 * The back-catalogue insight — "your DM-funnel reels hit 552K, and in the last
 * 30 days you made zero like it" — is pure arithmetic, so it can be tested
 * exactly rather than asserted about a model's output.
 */
beforeAll(() => {
  useTempDb();

  const me = upsertAccount({ handle: 'me', role: 'self' });

  const archetypeIds = ['dm funnel', 'behind the scenes'].map((name, index) => {
    const centroid = new Float32Array(4);
    centroid[index] = 1;
    return db()
      .insert(archetypes)
      .values({
        clusterId: index,
        runId: 'test',
        name,
        description: '',
        centroid: toBlob(centroid),
        dim: 4,
        size: 0,
        active: true,
      })
      .returning({ id: archetypes.id })
      .get().id;
  });

  const add = (opts: {
    id: number;
    likes: number;
    daysAgo: number;
    archetypeId: number;
    outlier: boolean;
  }): void => {
    const post = db()
      .insert(posts)
      .values({
        accountId: me.id,
        shortcode: `S${opts.id}`,
        type: 'reel',
        caption: 'x',
        takenAt: nowS - opts.daysAgo * DAY,
        likes: opts.likes,
        comments: 1,
        raw: {},
      })
      .returning({ id: posts.id })
      .get();

    db()
      .insert(postFeatures)
      .values({ postId: post.id, isOutlier: opts.outlier, engagementRate: 0.05 })
      .run();
    db()
      .insert(postLabels)
      .values({ postId: post.id, archetypeId: opts.archetypeId, distance: 0.1 })
      .run();
  };

  // "dm funnel" was a hit — but nothing in the last 90 days.
  add({ id: 1, likes: 552_000, daysAgo: 200, archetypeId: archetypeIds[0]!, outlier: true });
  add({ id: 2, likes: 480_000, daysAgo: 180, archetypeId: archetypeIds[0]!, outlier: true });

  // "behind the scenes" also won, and is still being posted.
  add({ id: 3, likes: 300_000, daysAgo: 150, archetypeId: archetypeIds[1]!, outlier: true });
  add({ id: 4, likes: 900, daysAgo: 5, archetypeId: archetypeIds[1]!, outlier: false });
});

afterAll(() => dropTempDb());

describe('decay detection', () => {
  it('finds archetypes that won before and are absent from the window', () => {
    const decayed = detectDecay(30, 2.5);
    expect(decayed.map((d) => d.name)).toEqual(['dm funnel']);
  });

  it('reports the numbers the claim needs', () => {
    const [row] = detectDecay(30, 2.5);
    expect(row?.winnerCount).toBe(2);
    expect(row?.recentCount).toBe(0);
    expect(row?.medianLikesWhenUsed).toBeGreaterThanOrEqual(480_000);
    expect(row?.lastUsedDaysAgo).toBeGreaterThan(90);
  });

  it('does not flag an archetype still in rotation', () => {
    expect(detectDecay(30, 2.5).some((d) => d.name === 'behind the scenes')).toBe(false);
  });

  it('widening the window can clear a decay signal', () => {
    // With a 365-day window, "dm funnel" has been used inside the window, so
    // it is no longer absent and should stop being reported.
    expect(detectDecay(365, 2.5)).toHaveLength(0);
  });
});
