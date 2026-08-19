import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  accounts,
  followerDaily,
  postComments,
  postInsights,
  posts,
  type Post,
} from '../db/schema';
import { riyadhDay } from '../time';
import type { AccountSnapshot, GraphComment, GraphMedia, MediaInsights } from './graph';

/**
 * Writes Graph API reads into the database. Kept apart from `lib/insights/graph.ts`
 * so the HTTP shapes and the storage shapes can drift independently — a Meta
 * field rename should touch one file, not both.
 */

const toDate = (epochS: number | null): Date | null =>
  epochS === null ? null : new Date(epochS * 1000);

export interface MediaUpsertSummary {
  inserted: number;
  updated: number;
}

/**
 * Idempotent on `shortcode`, the same key the Apify path uses — so a post
 * that was scraped under v1 and is now fetched from the Graph API updates in
 * place and flips to `source: 'graph'` rather than duplicating.
 */
export async function upsertGraphMedia(
  accountId: number,
  media: GraphMedia[],
): Promise<MediaUpsertSummary> {
  if (media.length === 0) return { inserted: 0, updated: 0 };

  const existing = new Set(
    (
      await db()
        .select({ shortcode: posts.shortcode })
        .from(posts)
        .where(
          inArray(
            posts.shortcode,
            media.map((m) => m.shortcode),
          ),
        )
    ).map((r) => r.shortcode),
  );

  const now = new Date();
  await db().transaction(async (tx) => {
    for (const m of media) {
      const values = {
        type: m.mediaType,
        caption: m.caption,
        takenAt: toDate(m.timestamp),
        likes: m.likes,
        comments: m.comments,
        thumbnailUrl: m.thumbnailUrl,
        permalink: m.permalink,
        igMediaId: m.id,
        source: 'graph' as const,
        raw: m.raw ?? {},
        lastSeenAt: now,
      };
      await tx
        .insert(posts)
        .values({
          accountId,
          shortcode: m.shortcode,
          ...values,
          firstSeenAt: now,
        })
        .onConflictDoUpdate({ target: posts.shortcode, set: values });
    }
  });

  const inserted = media.filter((m) => !existing.has(m.shortcode)).length;
  return { inserted, updated: media.length - inserted };
}

/**
 * One row per (post, checkpoint). `latest` is overwritten every run; the
 * fixed checkpoints are written once and then left alone, because the whole
 * point of `t24` is that it is the number *at* 24 hours.
 */
export async function recordInsights(
  postId: number,
  checkpoint: 't24' | 't48' | 't7d' | 'latest',
  insights: MediaInsights,
): Promise<void> {
  const values = {
    reach: insights.reach,
    views: insights.views,
    saves: insights.saves,
    shares: insights.shares,
    likes: insights.likes,
    comments: insights.comments,
    totalInteractions: insights.totalInteractions,
    unavailable: insights.unavailable,
    capturedAt: new Date(),
  };

  if (checkpoint === 'latest') {
    await db()
      .insert(postInsights)
      .values({ postId, checkpoint, ...values })
      .onConflictDoUpdate({
        target: [postInsights.postId, postInsights.checkpoint],
        set: values,
      });
    return;
  }

  await db()
    .insert(postInsights)
    .values({ postId, checkpoint, ...values })
    .onConflictDoNothing({ target: [postInsights.postId, postInsights.checkpoint] });
}

/** Which fixed checkpoints a post has passed but not yet had captured. */
export function dueCheckpoints(
  takenAt: Date | null,
  already: string[],
  now: Date = new Date(),
): ('t24' | 't48' | 't7d')[] {
  if (!takenAt) return [];
  const ageHours = (now.getTime() - takenAt.getTime()) / 3_600_000;
  const due: ('t24' | 't48' | 't7d')[] = [];
  if (ageHours >= 24 && !already.includes('t24')) due.push('t24');
  if (ageHours >= 48 && !already.includes('t48')) due.push('t48');
  if (ageHours >= 168 && !already.includes('t7d')) due.push('t7d');
  return due;
}

export async function upsertComments(
  postId: number,
  comments: GraphComment[],
): Promise<{ inserted: number }> {
  if (comments.length === 0) return { inserted: 0 };

  const existing = new Set(
    (
      await db()
        .select({ igCommentId: postComments.igCommentId })
        .from(postComments)
        .where(
          inArray(
            postComments.igCommentId,
            comments.map((c) => c.id),
          ),
        )
    ).map((r) => r.igCommentId),
  );

  await db().transaction(async (tx) => {
    for (const c of comments) {
      await tx
        .insert(postComments)
        .values({
          postId,
          igCommentId: c.id,
          username: c.username,
          text: c.text,
          likeCount: c.likeCount,
          commentedAt: toDate(c.timestamp),
        })
        .onConflictDoUpdate({
          target: postComments.igCommentId,
          // Comment text is editable and likes move; who said it and when do not.
          set: { text: c.text, likeCount: c.likeCount },
        });
    }
  });

  return { inserted: comments.filter((c) => !existing.has(c.id)).length };
}

/**
 * One row per Riyadh day. Re-running the same day overwrites it — the last
 * reading of the day is the one worth keeping, and a partial earlier reading
 * should not survive as a phantom drop.
 */
export async function recordFollowerDay(
  snapshot: AccountSnapshot,
  now: Date = new Date(),
): Promise<void> {
  const values = {
    followerCount: snapshot.followers,
    follows: snapshot.follows,
    unfollows: snapshot.unfollows,
    unavailableReason: snapshot.unavailableReason,
    capturedAt: now,
  };
  await db()
    .insert(followerDaily)
    .values({ day: riyadhDay(now), ...values })
    .onConflictDoUpdate({ target: followerDaily.day, set: values });
}

export async function applyProfileSnapshot(
  accountId: number,
  snapshot: AccountSnapshot,
): Promise<void> {
  await db()
    .update(accounts)
    .set({
      followers: snapshot.followers,
      following: snapshot.profile.followsCount,
      postsCount: snapshot.profile.mediaCount,
    })
    .where(eq(accounts.id, accountId));
}

/** Posts from the Graph API that still need insight capture, newest first. */
export async function graphPostsNeedingInsights(
  accountId: number,
  limit = 50,
): Promise<(Post & { captured: string[] })[]> {
  const rows = await db()
    .select({
      post: posts,
      captured: sql<
        string[]
      >`coalesce(array_agg(${postInsights.checkpoint}) filter (where ${postInsights.checkpoint} is not null), '{}')`,
    })
    .from(posts)
    .leftJoin(postInsights, eq(postInsights.postId, posts.id))
    .where(and(eq(posts.accountId, accountId), eq(posts.source, 'graph')))
    .groupBy(posts.id)
    .orderBy(desc(posts.takenAt))
    .limit(limit);

  return rows.map((r) => ({ ...r.post, captured: r.captured }));
}
