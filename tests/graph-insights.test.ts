import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, followerDaily, postComments, postInsights, posts } from '../lib/db/schema';
import { __setGraphFetchForTests, inspectToken } from '../lib/publish/graph';
import {
  fetchAccountSnapshot,
  fetchMediaComments,
  fetchMediaInsights,
  fetchOwnMedia,
} from '../lib/insights/graph';
import {
  dueCheckpoints,
  recordFollowerDay,
  recordInsights,
  upsertComments,
  upsertGraphMedia,
} from '../lib/insights/ingest';
import { followerHistory } from '../lib/insights/followers';
import { upsertAccount } from '../lib/ingest/upsert';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(async () => {
  __setGraphFetchForTests(null);
  await db().delete(postInsights);
  await db().delete(postComments);
  await db().delete(followerDaily);
  await db().delete(posts);
  await db().delete(accounts);
});

afterAll(async () => {
  await closeDb();
});

describe('fetchOwnMedia', () => {
  it('normalises media types and derives a shortcode from the permalink when absent', async () => {
    __setGraphFetchForTests(async () =>
      jsonResponse({
        data: [
          {
            id: '1',
            media_type: 'VIDEO',
            media_product_type: 'REELS',
            permalink: 'https://www.instagram.com/reel/ABC123/',
            timestamp: '2026-08-01T10:00:00+0000',
            like_count: 10,
            comments_count: 2,
          },
          {
            id: '2',
            shortcode: 'XYZ789',
            media_type: 'CAROUSEL_ALBUM',
            permalink: 'https://www.instagram.com/p/XYZ789/',
          },
        ],
      }),
    );

    const { media } = await fetchOwnMedia({ igUserId: 'IGU', token: 'TOK' });
    expect(media.map((m) => m.shortcode)).toEqual(['ABC123', 'XYZ789']);
    expect(media[0]!.mediaType).toBe('reel');
    expect(media[1]!.mediaType).toBe('carousel');
    expect(media[0]!.likes).toBe(10);
  });

  it('stops at a shortcode it already holds rather than paging through everything', async () => {
    __setGraphFetchForTests(async () =>
      jsonResponse({
        data: [
          { id: '1', shortcode: 'NEW1', permalink: 'https://x/p/NEW1/' },
          { id: '2', shortcode: 'SEEN', permalink: 'https://x/p/SEEN/' },
          { id: '3', shortcode: 'OLD', permalink: 'https://x/p/OLD/' },
        ],
      }),
    );

    const { media } = await fetchOwnMedia({
      igUserId: 'IGU',
      token: 'TOK',
      stopAt: new Set(['SEEN']),
    });
    expect(media.map((m) => m.shortcode)).toEqual(['NEW1']);
  });
});

describe('fetchMediaInsights', () => {
  it('maps Meta metric names onto the stored shape', async () => {
    __setGraphFetchForTests(async () =>
      jsonResponse({
        data: [
          { name: 'reach', values: [{ value: 500 }] },
          { name: 'saved', values: [{ value: 12 }] },
          { name: 'total_interactions', total_value: { value: 90 } },
        ],
      }),
    );

    const insights = await fetchMediaInsights({ mediaId: 'm1', token: 'TOK', mediaType: 'image' });
    expect(insights.reach).toBe(500);
    expect(insights.saves).toBe(12);
    expect(insights.totalInteractions).toBe(90);
    // Not returned by the API — must be null, never 0.
    expect(insights.views).toBeNull();
    expect(insights.shares).toBeNull();
  });

  it('retries metric-by-metric when one retired name 400s the whole request', async () => {
    let call = 0;
    __setGraphFetchForTests(async (input) => {
      call++;
      const url = String(input);
      // The batched request fails because it contains `views`.
      if (call === 1) {
        return jsonResponse(
          { error: { message: 'metric[0] must be a valid insights metric' } },
          400,
        );
      }
      if (url.includes('metric=views')) {
        return jsonResponse({ error: { message: 'views is not supported' } }, 400);
      }
      const metric = /metric=([a-z_]+)/.exec(url)?.[1] ?? 'reach';
      return jsonResponse({ data: [{ name: metric, values: [{ value: 7 }] }] });
    });

    const insights = await fetchMediaInsights({ mediaId: 'm1', token: 'TOK', mediaType: 'reel' });
    expect(insights.reach).toBe(7);
    expect(insights.views).toBeNull();
    expect(insights.unavailable).toContain('views');
  });

  it('returns every metric null, with reasons, when the API refuses all of them', async () => {
    __setGraphFetchForTests(async () => jsonResponse({ error: { message: 'nope' } }, 400));
    const insights = await fetchMediaInsights({ mediaId: 'm1', token: 'TOK', mediaType: 'image' });
    expect(insights.reach).toBeNull();
    expect(insights.totalInteractions).toBeNull();
    expect(insights.unavailable.length).toBeGreaterThan(0);
  });
});

describe('fetchAccountSnapshot', () => {
  it('reads the follower count and the follows/unfollows breakdown', async () => {
    __setGraphFetchForTests(async (input) => {
      if (String(input).includes('/insights')) {
        return jsonResponse({
          data: [
            {
              name: 'follows_and_unfollows',
              total_value: {
                breakdowns: [
                  {
                    results: [
                      { dimension_values: ['FOLLOWER'], value: 30 },
                      { dimension_values: ['UNFOLLOWER'], value: 8 },
                    ],
                  },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({
        username: 'me',
        followers_count: 1200,
        follows_count: 300,
        media_count: 88,
      });
    });

    const snapshot = await fetchAccountSnapshot({ igUserId: 'IGU', token: 'TOK' });
    expect(snapshot.followers).toBe(1200);
    expect(snapshot.follows).toBe(30);
    expect(snapshot.unfollows).toBe(8);
    expect(snapshot.unavailableReason).toBeNull();
  });

  it('keeps the follower count and records why when follows/unfollows are unavailable', async () => {
    __setGraphFetchForTests(async (input) => {
      if (String(input).includes('/insights')) {
        return jsonResponse({ error: { message: 'requires at least 100 followers' } }, 400);
      }
      return jsonResponse({ username: 'me', followers_count: 40 });
    });

    const snapshot = await fetchAccountSnapshot({ igUserId: 'IGU', token: 'TOK' });
    expect(snapshot.followers).toBe(40);
    expect(snapshot.follows).toBeNull();
    expect(snapshot.unfollows).toBeNull();
    expect(snapshot.unavailableReason).toMatch(/100 followers/);
  });
});

describe('inspectToken scope checking', () => {
  it('names the scopes v2 needs but the token lacks', async () => {
    __setGraphFetchForTests(async () =>
      jsonResponse({
        data: {
          is_valid: true,
          expires_at: Math.floor(Date.now() / 1000) + 40 * 86_400,
          scopes: ['instagram_basic', 'pages_show_list'],
        },
      }),
    );
    const info = await inspectToken('TOK');
    expect(info.valid).toBe(true);
    expect(info.missingScopes).toContain('instagram_manage_insights');
    expect(info.missingScopes).toContain('instagram_manage_comments');
    expect(info.detail).toMatch(/missing scope/);
  });

  it('does not cry wolf when debug_token omits scopes entirely', async () => {
    __setGraphFetchForTests(async () => jsonResponse({ data: { is_valid: true, expires_at: 0 } }));
    const info = await inspectToken('TOK');
    expect(info.missingScopes).toEqual([]);
  });
});

describe('ingest', () => {
  it('upserts Graph media idempotently and flips a scraped post to source=graph', async () => {
    const account = await upsertAccount({ handle: 'graphself', role: 'self' });
    await db().insert(posts).values({
      accountId: account.id,
      shortcode: 'SAME',
      type: 'image',
      raw: {},
      likes: 1,
    });

    const first = await upsertGraphMedia(account.id, [
      {
        id: 'm1',
        shortcode: 'SAME',
        caption: 'hello',
        mediaType: 'reel',
        timestamp: 1_780_000_000,
        permalink: 'https://x/reel/SAME/',
        thumbnailUrl: null,
        likes: 99,
        comments: 3,
        raw: { id: 'm1' },
      },
    ]);
    expect(first).toEqual({ inserted: 0, updated: 1 });

    const [row] = await db().select().from(posts);
    expect(row!.source).toBe('graph');
    expect(row!.igMediaId).toBe('m1');
    expect(row!.likes).toBe(99);
    expect(row!.type).toBe('reel');
  });

  it('writes latest every time but a fixed checkpoint only once', async () => {
    const account = await upsertAccount({ handle: 'ckself', role: 'self' });
    const [post] = await db()
      .insert(posts)
      .values({ accountId: account.id, shortcode: 'CK', type: 'image', raw: {} })
      .returning({ id: posts.id });

    const shape = (reach: number) => ({
      reach,
      views: null,
      saves: null,
      shares: null,
      totalInteractions: null,
      likes: null,
      comments: null,
      unavailable: [],
    });

    await recordInsights(post!.id, 'latest', shape(10));
    await recordInsights(post!.id, 'latest', shape(20));
    await recordInsights(post!.id, 't24', shape(10));
    await recordInsights(post!.id, 't24', shape(20));

    const rows = await db().select().from(postInsights);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.checkpoint === 'latest')!.reach).toBe(20);
    // t24 is the number *at* 24 hours — a later reading must not overwrite it.
    expect(rows.find((r) => r.checkpoint === 't24')!.reach).toBe(10);
  });

  it('dueCheckpoints only returns checkpoints the post has passed and not yet captured', () => {
    const now = new Date('2026-08-19T12:00:00Z');
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

    expect(dueCheckpoints(hoursAgo(10), [], now)).toEqual([]);
    expect(dueCheckpoints(hoursAgo(30), [], now)).toEqual(['t24']);
    expect(dueCheckpoints(hoursAgo(50), ['t24'], now)).toEqual(['t48']);
    expect(dueCheckpoints(hoursAgo(200), ['t24', 't48'], now)).toEqual(['t7d']);
    expect(dueCheckpoints(null, [], now)).toEqual([]);
  });

  it('upserts comments idempotently on the Instagram comment id', async () => {
    const account = await upsertAccount({ handle: 'cself', role: 'self' });
    const [post] = await db()
      .insert(posts)
      .values({ accountId: account.id, shortcode: 'C1', type: 'image', raw: {} })
      .returning({ id: posts.id });

    const comment = {
      id: 'c1',
      username: 'fan',
      text: 'nice',
      likeCount: 1,
      timestamp: 1_780_000_000,
    };
    expect(await upsertComments(post!.id, [comment])).toEqual({ inserted: 1 });
    expect(await upsertComments(post!.id, [{ ...comment, text: 'edited' }])).toEqual({
      inserted: 0,
    });

    const rows = await db().select().from(postComments);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('edited');
    expect(rows[0]!.username).toBe('fan');
  });
});

describe('follower history', () => {
  const snapshot = (followers: number | null, reason: string | null = null) => ({
    followers,
    follows: null,
    unfollows: null,
    unavailableReason: reason,
    profile: { username: null, followsCount: null, mediaCount: null },
  });

  it('derives day-over-day change, and refuses to across a gap', async () => {
    await recordFollowerDay(snapshot(100), new Date('2026-08-16T09:00:00Z'));
    await recordFollowerDay(snapshot(110), new Date('2026-08-17T09:00:00Z'));
    // 18th missing entirely — a gap, not a flat day.
    await recordFollowerDay(snapshot(150), new Date('2026-08-19T09:00:00Z'));

    const history = await followerHistory(10);
    expect(history.map((h) => h.day)).toEqual(['2026-08-19', '2026-08-17', '2026-08-16']);
    expect(history[0]!.change).toBeNull();
    expect(history[1]!.change).toBe(10);
  });

  it('overwrites the same Riyadh day rather than stacking readings', async () => {
    const morning = new Date('2026-08-19T05:00:00Z');
    const evening = new Date('2026-08-19T18:00:00Z');
    await recordFollowerDay(snapshot(100), morning);
    await recordFollowerDay(snapshot(105), evening);

    const rows = await db().select().from(followerDaily);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.followerCount).toBe(105);
  });
});

describe('fetchMediaComments', () => {
  it('collects a page of comments', async () => {
    __setGraphFetchForTests(async () =>
      jsonResponse({
        data: [
          { id: 'c1', username: 'a', text: 'hi', timestamp: '2026-08-01T10:00:00+0000' },
          { id: 'c2', username: 'b', text: 'yo' },
        ],
      }),
    );
    const comments = await fetchMediaComments({ mediaId: 'm1', token: 'TOK' });
    expect(comments.map((c) => c.username)).toEqual(['a', 'b']);
    expect(comments[0]!.timestamp).toBeGreaterThan(0);
    expect(comments[1]!.timestamp).toBeNull();
  });
});
