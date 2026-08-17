import {
  scrapedPostSchema,
  scrapedProfileSchema,
  type ScrapedPost,
  type ScrapedProfile,
} from '../providers/scraper/types';

/**
 * Actor payload → our shape.
 *
 * Instagram scrapers rename fields between releases, so every read here is a
 * list of candidates rather than a single key, and anything unrecognised still
 * survives in `posts.raw`. When a field moves, add the new name to the list and
 * re-normalise from `raw` — no re-scrape, no credits.
 *
 * Field names verified against apify/instagram-scraper output at the time of
 * writing; confirm against the actor's Store page and record drift in NOTES.md.
 */

type Row = Record<string, unknown>;

function pick(row: Row, keys: string[]): unknown {
  for (const key of keys) {
    const value = key.includes('.') ? deep(row, key) : row[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function deep(row: Row, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object') return (acc as Row)[part];
    return undefined;
  }, row);
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function epoch(value: unknown): number | null {
  if (typeof value === 'number') {
    // Some actors emit milliseconds, some seconds. Anything past ~2001 in
    // seconds is below 1e12, so the threshold separates them safely.
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

export function normalizePostType(row: Row): ScrapedPost['type'] {
  const raw = String(
    pick(row, ['type', 'productType', 'product_type', '__typename']) ?? '',
  ).toLowerCase();
  const isVideo = pick(row, ['isVideo', 'is_video']) === true;
  const children = pick(row, ['childPosts', 'sidecarChildren', 'edge_sidecar_to_children.edges']);

  if (raw.includes('clips') || raw.includes('reel')) return 'reel';
  if (raw.includes('sidecar') || raw.includes('carousel')) return 'carousel';
  if (Array.isArray(children) && children.length > 1) return 'carousel';
  if (raw.includes('video') || isVideo) {
    // A vertical video with a clips product type is a reel; anything else is a
    // feed video. When we can't tell, "video" is the honest answer.
    const duration = num(pick(row, ['videoDuration', 'video_duration']));
    return duration !== null && duration <= 90 ? 'reel' : 'video';
  }
  if (raw.includes('image') || raw.includes('graphimage') || raw.includes('photo')) return 'image';
  return 'unknown';
}

export function normalizePost(row: Row): ScrapedPost | null {
  const shortcode = str(pick(row, ['shortCode', 'shortcode', 'code', 'id']));
  if (!shortcode) return null;

  const children = pick(row, ['childPosts', 'sidecarChildren']);
  const mediaUrls = [
    ...(Array.isArray(children)
      ? children.flatMap((child) => {
          const url = pick(child as Row, ['videoUrl', 'displayUrl', 'video_url', 'display_url']);
          return typeof url === 'string' ? [url] : [];
        })
      : []),
    ...((): string[] => {
      const url = pick(row, ['videoUrl', 'displayUrl', 'video_url', 'display_url']);
      return typeof url === 'string' ? [url] : [];
    })(),
  ];

  return scrapedPostSchema.parse({
    shortcode,
    type: normalizePostType(row),
    caption: str(pick(row, ['caption', 'text', 'edge_media_to_caption.edges.0.node.text'])),
    takenAt: epoch(pick(row, ['timestamp', 'takenAt', 'taken_at_timestamp', 'taken_at'])),
    likes: num(pick(row, ['likesCount', 'likes', 'edge_liked_by.count', 'like_count'])),
    comments: num(pick(row, ['commentsCount', 'comments', 'comment_count'])),
    views: num(pick(row, ['videoViewCount', 'viewsCount', 'video_view_count', 'view_count'])),
    plays: num(pick(row, ['videoPlayCount', 'playsCount', 'play_count'])),
    durationS: num(pick(row, ['videoDuration', 'video_duration'])),
    carouselCount: Array.isArray(children) ? children.length : null,
    thumbnailUrl: str(pick(row, ['displayUrl', 'thumbnailUrl', 'display_url', 'thumbnail_src'])),
    mediaUrls: [...new Set(mediaUrls)],
    isSponsored: pick(row, ['isSponsored', 'is_paid_partnership']) === true,
    raw: row,
  });
}

export function normalizeProfile(row: Row, fallbackHandle: string): ScrapedProfile {
  return scrapedProfileSchema.parse({
    handle: str(pick(row, ['username', 'ownerUsername', 'handle'])) ?? fallbackHandle,
    igUserId: (() => {
      const id = pick(row, ['id', 'ownerId', 'userId', 'pk']);
      return id === undefined ? null : String(id);
    })(),
    fullName: str(pick(row, ['fullName', 'full_name'])),
    bio: str(pick(row, ['biography', 'bio'])),
    followers: num(pick(row, ['followersCount', 'followers', 'edge_followed_by.count'])),
    following: num(pick(row, ['followsCount', 'following', 'edge_follow.count'])),
    postsCount: num(pick(row, ['postsCount', 'posts', 'edge_owner_to_timeline_media.count'])),
    isVerified: pick(row, ['verified', 'is_verified']) === true,
  });
}

/**
 * Actors return either a profile object with a nested posts array, or a flat
 * list of posts. Handle both without caring which.
 */
export function normalizeDataset(
  items: unknown[],
  handle: string,
): { profile: ScrapedProfile | null; posts: ScrapedPost[] } {
  let profile: ScrapedProfile | null = null;
  const posts: ScrapedPost[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Row;

    const nested = pick(row, ['latestPosts', 'posts', 'topPosts']);
    if (Array.isArray(nested)) {
      profile ??= normalizeProfile(row, handle);
      for (const child of nested) {
        if (child && typeof child === 'object') {
          const post = normalizePost(child as Row);
          if (post) posts.push(post);
        }
      }
      continue;
    }

    const post = normalizePost(row);
    if (post) {
      posts.push(post);
      // Post rows carry owner stats on some actors; better than nothing.
      profile ??= pick(row, ['ownerUsername', 'ownerFullName'])
        ? normalizeProfile(row, handle)
        : null;
    }
  }

  return { profile, posts };
}
