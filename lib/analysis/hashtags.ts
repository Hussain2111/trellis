import type { Post } from '../db/schema';

/** Pulls #hashtags out of a caption, lowercased, without the leading `#`. */
export function extractHashtags(caption: string | null): string[] {
  if (!caption) return [];
  const matches = caption.match(/#([a-z0-9_][\w]*)/gi) ?? [];
  return matches.map((m) => m.slice(1).toLowerCase());
}

/**
 * The account's most-used hashtags, ranked by frequency across its own posts.
 * This is the deterministic seed for competitor discovery — no model call
 * involved, matching the spec's "scraping the account's most-used hashtags".
 */
export function topHashtags(posts: Pick<Post, 'caption'>[], limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const tag of extractHashtags(post.caption)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag]) => tag);
}

export interface HashtagPost {
  username: string;
  likes: number;
  comments: number;
}

export interface RankedAccount {
  handle: string;
  score: number;
  postCount: number;
  hashtags: string[];
}

/**
 * Ranks the accounts that showed up under the scanned hashtags by aggregate
 * engagement — "the accounts that dominate those hashtags by engagement",
 * per the spec. `excludeHandles` keeps the self account (and anything
 * already a known competitor) out of its own discovery results.
 */
export function rankAccountsByEngagement(
  byHashtag: { hashtag: string; posts: HashtagPost[] }[],
  excludeHandles: Set<string>,
  limit = 6,
): RankedAccount[] {
  const byHandle = new Map<string, RankedAccount>();

  for (const { hashtag, posts } of byHashtag) {
    for (const post of posts) {
      const handle = post.username.replace(/^@/, '').trim().toLowerCase();
      if (!handle || excludeHandles.has(handle)) continue;

      const existing = byHandle.get(handle);
      const engagement = (post.likes ?? 0) + (post.comments ?? 0) * 3;
      if (existing) {
        existing.score += engagement;
        existing.postCount += 1;
        if (!existing.hashtags.includes(hashtag)) existing.hashtags.push(hashtag);
      } else {
        byHandle.set(handle, { handle, score: engagement, postCount: 1, hashtags: [hashtag] });
      }
    }
  }

  return [...byHandle.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
