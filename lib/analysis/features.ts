import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { postFeatures, posts, type Post } from '../db/schema';
import { median, robustZ, trailingMedian } from './stats';

/**
 * Layer A: per-post features, computed deterministically. Free, exact, and
 * rerunnable — if any of this needed a model call it would take an afternoon
 * and cost quota every time the definition changed.
 */

// Matches emoji including ZWJ sequences, skin-tone modifiers and flags.
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const HASHTAG_RE = /(^|\s)#[\p{L}\p{N}_]+/gu;
const MENTION_RE = /(^|\s)@[\w.]+/gu;

/**
 * Phrases that ask for an action. Deliberately conservative: a false positive
 * here quietly corrupts a benchmark claim like "62% of winners end on a CTA".
 */
const CTA_PATTERNS = [
  /\b(comment|drop|type|reply)\b[^.!?]{0,40}\b(below|word|yes|link)\b/i,
  /\bdm\b[^.!?]{0,30}\b(me|us|the word)\b/i,
  /\b(link in bio|check the link|swipe up|tap the link)\b/i,
  /\b(save (this|it)|share (this|it) with|send (this|it) to|follow for)\b/i,
  /\b(sign up|download|grab|get) (the|my|your)\b/i,
];

export function firstLine(caption: string | null): string {
  if (!caption) return '';
  const line = caption
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? '';
}

/** The string that stands in for "how this post opens" — reels are caption-only for v1, no transcription. */
export function hookText(caption: string | null): string {
  return firstLine(caption)
    .replace(HASHTAG_RE, ' ')
    .replace(MENTION_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

export interface ComputedFeatures {
  captionLength: number;
  firstLine: string;
  hookText: string;
  hashtagCount: number;
  mentionCount: number;
  emojiCount: number;
  hasQuestion: boolean;
  hasCta: boolean;
  postedHour: number | null;
  postedDow: number | null;
  engagementRate: number | null;
}

/**
 * Engagement normalised by follower count. Raw likes across differently-sized
 * accounts are meaningless — a 400-like post from a 5k account beats a
 * 2,000-like post from a 200k account, and the benchmark has to see that.
 */
export function engagementRate(post: Post, followers: number | null): number | null {
  const interactions = (post.likes ?? 0) + (post.comments ?? 0);
  if (!followers || followers <= 0) return null;
  return interactions / followers;
}

export function computeFeatures(post: Post, followers: number | null): ComputedFeatures {
  const caption = post.caption ?? '';
  const line = firstLine(caption);

  return {
    captionLength: caption.length,
    firstLine: line,
    hookText: hookText(caption),
    hashtagCount: countMatches(caption, HASHTAG_RE),
    mentionCount: countMatches(caption, MENTION_RE),
    emojiCount: countMatches(caption, EMOJI_RE),
    hasQuestion: /\?/.test(line) || /\?/.test(caption.slice(0, 220)),
    hasCta: CTA_PATTERNS.some((re) => re.test(caption)),
    postedHour: post.takenAt ? post.takenAt.getUTCHours() : null,
    postedDow: post.takenAt ? post.takenAt.getUTCDay() : null,
    engagementRate: engagementRate(post, followers),
  };
}

export interface OutlierInput {
  post: Post;
  engagementRate: number | null;
}

/**
 * "My winners": posts well above my own trailing median. Compared against a
 * trailing window rather than the whole history, so a post from when the
 * account was a third the size still counts as the hit it was.
 */
export function markOutliers(
  rows: OutlierInput[],
  multiplier: number,
  window = 20,
): Map<number, { isOutlier: boolean; likesZ: number; viewsZ: number }> {
  const chronological = [...rows].sort(
    (a, b) => (a.post.takenAt?.getTime() ?? 0) - (b.post.takenAt?.getTime() ?? 0),
  );

  const likeSeries = chronological.map((r) => r.post.likes ?? 0);
  const viewSeries = chronological.map((r) => r.post.views ?? r.post.plays ?? 0);
  const allLikes = likeSeries.filter((v) => v > 0);
  const allViews = viewSeries.filter((v) => v > 0);

  const out = new Map<number, { isOutlier: boolean; likesZ: number; viewsZ: number }>();

  chronological.forEach((row, index) => {
    const likes = likeSeries[index]!;
    const baseline = trailingMedian(likeSeries.slice(0, index + 1), index, window);
    // Before there is any history to compare against, nothing is an outlier.
    const isOutlier = baseline > 0 && index >= 5 && likes >= baseline * multiplier;

    out.set(row.post.id, {
      isOutlier,
      likesZ: allLikes.length > 1 ? robustZ(likes, allLikes) : 0,
      viewsZ: allViews.length > 1 ? robustZ(viewSeries[index]!, allViews) : 0,
    });
  });

  return out;
}

/** Recompute and persist features for one account. Idempotent. */
export async function persistFeatures(
  accountId: number,
  followers: number | null,
  multiplier: number,
): Promise<number> {
  const rows = await db().select().from(posts).where(eq(posts.accountId, accountId));
  if (rows.length === 0) return 0;

  const withRates = rows.map((post) => ({ post, engagementRate: engagementRate(post, followers) }));
  const outliers = markOutliers(withRates, multiplier);

  await db().transaction(async (tx) => {
    for (const post of rows) {
      const f = computeFeatures(post, followers);
      const o = outliers.get(post.id);
      const values = {
        postId: post.id,
        captionLength: f.captionLength,
        firstLine: f.firstLine,
        hookText: f.hookText,
        hashtagCount: f.hashtagCount,
        mentionCount: f.mentionCount,
        emojiCount: f.emojiCount,
        hasQuestion: f.hasQuestion,
        hasCta: f.hasCta,
        postedHour: f.postedHour,
        postedDow: f.postedDow,
        engagementRate: f.engagementRate,
        likesZ: o?.likesZ ?? 0,
        viewsZ: o?.viewsZ ?? 0,
        isOutlier: o?.isOutlier ?? false,
        computedAt: new Date(),
      };
      await tx
        .insert(postFeatures)
        .values(values)
        .onConflictDoUpdate({ target: postFeatures.postId, set: values });
    }
  });

  return rows.length;
}

export interface FormatSummary {
  type: string;
  count: number;
  medianLikes: number;
  medianComments: number;
  medianEngagementRate: number;
  medianViews: number | null;
}

export function summariseByFormat(rows: Post[], followers: number | null): FormatSummary[] {
  const groups = new Map<string, Post[]>();
  for (const post of rows) {
    const list = groups.get(post.type) ?? [];
    list.push(post);
    groups.set(post.type, list);
  }

  return [...groups.entries()]
    .map(([type, list]) => {
      const views = list.map((p) => p.views ?? p.plays ?? 0).filter((v) => v > 0);
      return {
        type,
        count: list.length,
        medianLikes: median(list.map((p) => p.likes ?? 0)),
        medianComments: median(list.map((p) => p.comments ?? 0)),
        medianEngagementRate: median(
          list.map((p) => engagementRate(p, followers) ?? 0).filter((v) => v > 0),
        ),
        medianViews: views.length > 0 ? median(views) : null,
      };
    })
    .sort((a, b) => b.count - a.count);
}
