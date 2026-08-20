import { GraphError, call } from '../publish/graph';
import { recordRun } from '../runs/log';

/**
 * The read half of the Instagram Graph API: the managed account's own media,
 * their insights, their comments, and account-level follower numbers. Free,
 * and on the same long-lived token the publisher already uses — the only
 * difference is scope (`instagram_manage_insights`,
 * `instagram_manage_comments`; see `REQUIRED_SCOPES` in ../publish/graph.ts).
 *
 * The governing rule here is that a metric Meta declines to serve must come
 * back as `null` with a reason, never as `0`. Meta retires and renames insight
 * metrics between API versions — `impressions` became `views`, `plays` folded
 * into it — and a version bump silently turning real engagement into zeros
 * would be indistinguishable from a post that flopped.
 */

export interface GraphMedia {
  id: string;
  shortcode: string;
  caption: string | null;
  mediaType: 'image' | 'carousel' | 'reel' | 'video' | 'unknown';
  timestamp: number | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  likes: number | null;
  comments: number | null;
  raw: unknown;
}

interface RawMedia {
  id: string;
  shortcode?: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  timestamp?: string;
  permalink?: string;
  thumbnail_url?: string;
  media_url?: string;
  like_count?: number;
  comments_count?: number;
  children?: { data: { id: string }[] };
}

const MEDIA_FIELDS = [
  'id',
  'shortcode',
  'caption',
  'media_type',
  'media_product_type',
  'timestamp',
  'permalink',
  'thumbnail_url',
  'media_url',
  'like_count',
  'comments_count',
  'children{id}',
].join(',');

function normaliseType(raw: RawMedia): GraphMedia['mediaType'] {
  if (raw.media_product_type === 'REELS') return 'reel';
  switch (raw.media_type) {
    case 'IMAGE':
      return 'image';
    case 'CAROUSEL_ALBUM':
      return 'carousel';
    case 'VIDEO':
      return 'video';
    default:
      return 'unknown';
  }
}

/**
 * `shortcode` is not guaranteed on every media edge, but it is this app's
 * primary key for a post. Falling back to the permalink slug keeps Graph rows
 * joinable with the Apify-scraped history, which is keyed the same way.
 */
function shortcodeOf(raw: RawMedia): string | null {
  if (raw.shortcode) return raw.shortcode;
  const match = raw.permalink?.match(/\/(?:p|reel|tv)\/([^/?]+)/);
  return match?.[1] ?? null;
}

function toMedia(raw: RawMedia): GraphMedia | null {
  const shortcode = shortcodeOf(raw);
  if (!shortcode) return null;
  return {
    id: raw.id,
    shortcode,
    caption: raw.caption ?? null,
    mediaType: normaliseType(raw),
    timestamp: raw.timestamp ? Math.floor(new Date(raw.timestamp).getTime() / 1000) : null,
    permalink: raw.permalink ?? null,
    thumbnailUrl: raw.thumbnail_url ?? raw.media_url ?? null,
    likes: raw.like_count ?? null,
    comments: raw.comments_count ?? null,
    raw,
  };
}

/**
 * The account's own media, newest first. Follows `paging.next` until `limit`
 * is reached or `stopAt` is hit — the same incremental stop-set the scraper
 * uses, so a daily sync fetches the few new posts rather than all of them.
 */
export async function fetchOwnMedia(options: {
  igUserId: string;
  token: string;
  limit?: number;
  stopAt?: Set<string>;
}): Promise<{ media: GraphMedia[]; complete: boolean }> {
  const limit = options.limit ?? 100;
  const collected: GraphMedia[] = [];
  let after: string | undefined;
  let complete = true;

  while (collected.length < limit) {
    const page = await call<{
      data: RawMedia[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>(`${options.igUserId}/media`, {
      token: options.token,
      params: {
        fields: MEDIA_FIELDS,
        limit: String(Math.min(50, limit - collected.length)),
        ...(after ? { after } : {}),
      },
    });

    if (page.data.length === 0) break;

    let stopped = false;
    for (const raw of page.data) {
      const media = toMedia(raw);
      if (!media) continue;
      if (options.stopAt?.has(media.shortcode)) {
        stopped = true;
        break;
      }
      collected.push(media);
      if (collected.length >= limit) break;
    }
    if (stopped) break;

    after = page.paging?.cursors?.after;
    if (!page.paging?.next || !after) break;
  }

  if (collected.length >= limit) complete = false;

  await recordRun({
    provider: 'instagram-graph',
    operation: 'fetch_own_media',
    status: 'ok',
    costEstimate: 0,
    meta: { count: collected.length },
  });

  return { media: collected, complete };
}

export interface MediaInsights {
  reach: number | null;
  views: number | null;
  saves: number | null;
  shares: number | null;
  totalInteractions: number | null;
  likes: number | null;
  comments: number | null;
  /** Metric names the API refused, so the UI can explain a blank cell. */
  unavailable: string[];
}

/** Metric names differ by media type, and asking for the wrong one 400s the whole call. */
const REELS_METRICS = [
  'reach',
  'views',
  'saved',
  'shares',
  'likes',
  'comments',
  'total_interactions',
];
const FEED_METRICS = [
  'reach',
  'views',
  'saved',
  'shares',
  'likes',
  'comments',
  'total_interactions',
];

const EMPTY_INSIGHTS: MediaInsights = {
  reach: null,
  views: null,
  saves: null,
  shares: null,
  totalInteractions: null,
  likes: null,
  comments: null,
  unavailable: [],
};

/**
 * One media's insights. Meta rejects the entire request when any single
 * requested metric is unsupported for that media, so an error triggers a
 * retry with the offending metrics dropped — the alternative is losing every
 * metric because one of them was renamed.
 */
export async function fetchMediaInsights(options: {
  mediaId: string;
  token: string;
  mediaType: GraphMedia['mediaType'];
}): Promise<MediaInsights> {
  const wanted = options.mediaType === 'reel' ? REELS_METRICS : FEED_METRICS;
  const attempt = await requestMetrics(options.mediaId, options.token, wanted);

  if (attempt.ok) return attempt.insights;

  // Second pass: ask for each metric on its own so one retired name doesn't
  // take the rest of them down with it.
  const values: Record<string, number> = {};
  const unavailable: string[] = [];
  for (const metric of wanted) {
    const single = await requestMetrics(options.mediaId, options.token, [metric]);
    if (single.ok) Object.assign(values, single.values);
    else unavailable.push(metric);
  }

  if (unavailable.length === wanted.length) {
    await recordRun({
      provider: 'instagram-graph',
      operation: 'media_insights',
      status: 'error',
      costEstimate: 0,
      error: attempt.error,
      meta: { mediaId: options.mediaId },
    });
    return { ...EMPTY_INSIGHTS, unavailable };
  }

  return { ...shape(values), unavailable };
}

function shape(values: Record<string, number>): MediaInsights {
  const get = (key: string): number | null => (key in values ? values[key]! : null);
  return {
    reach: get('reach'),
    views: get('views'),
    saves: get('saved'),
    shares: get('shares'),
    totalInteractions: get('total_interactions'),
    likes: get('likes'),
    comments: get('comments'),
    unavailable: [],
  };
}

async function requestMetrics(
  mediaId: string,
  token: string,
  metrics: string[],
): Promise<
  | { ok: true; insights: MediaInsights; values: Record<string, number> }
  | { ok: false; error: string }
> {
  try {
    const result = await call<{
      data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[];
    }>(`${mediaId}/insights`, { token, params: { metric: metrics.join(',') } });

    const values: Record<string, number> = {};
    for (const row of result.data) {
      const value = row.total_value?.value ?? row.values?.[0]?.value;
      if (typeof value === 'number') values[row.name] = value;
    }
    return { ok: true, insights: shape(values), values };
  } catch (error) {
    if (error instanceof GraphError) return { ok: false, error: error.message };
    throw error;
  }
}

export interface GraphComment {
  id: string;
  username: string | null;
  text: string | null;
  likeCount: number | null;
  timestamp: number | null;
}

/** Comments on one media. Needs `instagram_manage_comments` on the token. */
export async function fetchMediaComments(options: {
  mediaId: string;
  token: string;
  limit?: number;
}): Promise<GraphComment[]> {
  const limit = options.limit ?? 100;
  const collected: GraphComment[] = [];
  let after: string | undefined;

  while (collected.length < limit) {
    const page = await call<{
      data: {
        id: string;
        username?: string;
        text?: string;
        like_count?: number;
        timestamp?: string;
      }[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>(`${options.mediaId}/comments`, {
      token: options.token,
      params: {
        fields: 'id,username,text,like_count,timestamp',
        limit: String(Math.min(50, limit - collected.length)),
        ...(after ? { after } : {}),
      },
    });

    for (const row of page.data) {
      collected.push({
        id: row.id,
        username: row.username ?? null,
        text: row.text ?? null,
        likeCount: row.like_count ?? null,
        timestamp: row.timestamp ? Math.floor(new Date(row.timestamp).getTime() / 1000) : null,
      });
    }

    after = page.paging?.cursors?.after;
    if (!page.paging?.next || !after) break;
  }

  return collected;
}

export interface AccountSnapshot {
  followers: number | null;
  follows: number | null;
  unfollows: number | null;
  /** Why follows/unfollows are null, when they are. */
  unavailableReason: string | null;
  profile: {
    username: string | null;
    followsCount: number | null;
    mediaCount: number | null;
  };
}

/**
 * Follower count comes off the account node (always available). Gross
 * follows/unfollows come from the `follows_and_unfollows` insight, which Meta
 * only serves to accounts over 100 followers and has moved between API
 * versions — so it is requested separately and its failure is recorded as a
 * reason string rather than being allowed to zero out the row.
 */
export async function fetchAccountSnapshot(options: {
  igUserId: string;
  token: string;
}): Promise<AccountSnapshot> {
  const profile = await call<{
    username?: string;
    followers_count?: number;
    follows_count?: number;
    media_count?: number;
  }>(options.igUserId, {
    token: options.token,
    params: { fields: 'username,followers_count,follows_count,media_count' },
  });

  let follows: number | null = null;
  let unfollows: number | null = null;
  let unavailableReason: string | null = null;

  try {
    const result = await call<{
      data: {
        name: string;
        total_value?: {
          breakdowns?: { results?: { dimension_values: string[]; value: number }[] }[];
        };
      }[];
    }>(`${options.igUserId}/insights`, {
      token: options.token,
      params: {
        metric: 'follows_and_unfollows',
        period: 'day',
        metric_type: 'total_value',
        breakdown: 'follow_type',
      },
    });

    const results = result.data[0]?.total_value?.breakdowns?.[0]?.results ?? [];
    for (const row of results) {
      const dimension = row.dimension_values[0];
      if (dimension === 'FOLLOWER') follows = row.value;
      if (dimension === 'NON_FOLLOWER' || dimension === 'UNFOLLOWER') unfollows = row.value;
    }
    if (results.length === 0) unavailableReason = 'API returned no follow_type breakdown';
  } catch (error) {
    unavailableReason =
      error instanceof GraphError
        ? error.message
        : `follows_and_unfollows unavailable: ${(error as Error).message}`;
  }

  return {
    followers: profile.followers_count ?? null,
    follows,
    unfollows,
    unavailableReason,
    profile: {
      username: profile.username ?? null,
      followsCount: profile.follows_count ?? null,
      mediaCount: profile.media_count ?? null,
    },
  };
}
