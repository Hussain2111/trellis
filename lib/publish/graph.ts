import { env } from '../env';
import { recordRun } from '../runs/log';

/**
 * Instagram Graph API publishing. Free to call, and viable for one
 * self-owned account without App Review under Standard Access (the account
 * holds a role on the developer's own app). See docs/instagram-setup.md.
 *
 * Container model: create a media container, poll until FINISHED, then
 * publish. Carousels create children first, then a parent with
 * media_type=CAROUSEL.
 */

/**
 * The single place the Graph API version is chosen, for reads and writes
 * alike — `lib/insights/graph.ts` routes through `call()` and has no version
 * of its own. `scripts/probe-graph.ts` reads the same `GRAPH_API_VERSION`
 * variable but keeps its own default on purpose: a probe that imports the
 * app's constants can only ever confirm them.
 */
const graphBase = (): string => `https://graph.facebook.com/${env().GRAPH_API_VERSION}`;

export class GraphError extends Error {
  readonly status: number;
  readonly permanent: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
    // 4xx other than rate limiting means the request itself is wrong; retrying
    // it will fail identically and just burn the attempt budget.
    this.permanent = status >= 400 && status < 500 && status !== 429;
  }
}

let fetchImpl: typeof fetch = (...args) => fetch(...args);

/** Test seam: swap in a fake fetch without touching the network or process.env. */
export function __setGraphFetchForTests(fn: typeof fetch | null): void {
  fetchImpl = fn ?? ((...args) => fetch(...args));
}

export async function call<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; token: string; params?: Record<string, string> },
): Promise<T> {
  const url = new URL(`${graphBase()}/${path}`);
  const body = new URLSearchParams({ access_token: options.token, ...(options.params ?? {}) });

  const res =
    options.method === 'POST'
      ? await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        })
      : await fetchImpl(`${url}?${body}`);

  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      message = parsed.error?.message ?? message;
    } catch {
      // keep the raw text
    }
    throw new GraphError(res.status, message);
  }
  return JSON.parse(text) as T;
}

export interface ContainerInput {
  igUserId: string;
  token: string;
  caption?: string;
  imageUrl?: string;
  videoUrl?: string;
  mediaType?: 'REELS' | 'CAROUSEL';
  isCarouselItem?: boolean;
  children?: string[];
}

export async function createContainer(input: ContainerInput): Promise<string> {
  const params: Record<string, string> = {};
  if (input.caption) params.caption = input.caption;
  if (input.imageUrl) params.image_url = input.imageUrl;
  if (input.videoUrl) params.video_url = input.videoUrl;
  if (input.mediaType) params.media_type = input.mediaType;
  if (input.isCarouselItem) params.is_carousel_item = 'true';
  if (input.children?.length) params.children = input.children.join(',');

  const result = await call<{ id: string }>(`${input.igUserId}/media`, {
    method: 'POST',
    token: input.token,
    params,
  });
  return result.id;
}

/** Video containers take a while to transcode; images are usually instant. */
export async function waitForContainer(
  containerId: string,
  token: string,
  options: { timeoutMs?: number; intervalMs?: number; onStatus?: (status: string) => void } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const intervalMs = options.intervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const result = await call<{ status_code: string; status?: string }>(containerId, {
      token,
      params: { fields: 'status_code,status' },
    });
    options.onStatus?.(result.status_code);

    if (result.status_code === 'FINISHED') return;
    if (result.status_code === 'ERROR' || result.status_code === 'EXPIRED') {
      throw new GraphError(400, `container ${result.status_code}: ${result.status ?? 'no detail'}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`container ${containerId} did not finish within ${timeoutMs / 1000}s`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function publishContainer(
  igUserId: string,
  containerId: string,
  token: string,
): Promise<string> {
  const result = await call<{ id: string }>(`${igUserId}/media_publish`, {
    method: 'POST',
    token,
    params: { creation_id: containerId },
  });
  return result.id;
}

/** Remaining publishes in the rolling 24h window, straight from Meta. */
export async function publishingLimit(
  igUserId: string,
  token: string,
): Promise<{ used: number; cap: number } | null> {
  try {
    const result = await call<{
      data: { quota_usage: number; config?: { quota_total?: number } }[];
    }>(`${igUserId}/content_publishing_limit`, { token, params: { fields: 'quota_usage,config' } });
    const row = result.data[0];
    if (!row) return null;
    return { used: row.quota_usage, cap: row.config?.quota_total ?? 25 };
  } catch {
    // Not fatal — the configured cap is the fallback.
    return null;
  }
}

/**
 * Scopes every v2 read depends on. A token missing one of these does not
 * fail — it quietly returns empty data, which is exactly the failure mode that
 * would put a believable zero in front of the user. So they are checked
 * explicitly rather than assumed.
 */
export const REQUIRED_SCOPES = [
  'instagram_basic',
  'instagram_manage_insights',
  'instagram_manage_comments',
  'pages_read_engagement',
  'pages_show_list',
  // Verified live: without this, `GET /me/accounts` returns `{"data": []}`
  // rather than an error — indistinguishable from "this user administers no
  // Pages". The setup step that discovers IG_USER_ID cannot be repeated
  // without it. Whether the ongoing insight reads need it is unproven (this
  // app never calls /me/accounts once IG_USER_ID is configured), but the cost
  // of requiring a scope you turned out not to need is nothing, and the cost
  // of a regenerated token missing it is a setup you cannot redo.
  'business_management',
] as const;

/**
 * Needed only by the auto-publish path, which is retained and off by default.
 * Kept separate from `REQUIRED_SCOPES` so an account that posts by hand isn't
 * warned about a scope it will never use — but still checked, because
 * regenerating a token for the insight scopes and forgetting this one silently
 * breaks publishing the next time it is enabled.
 */
export const PUBLISHING_SCOPES = ['instagram_content_publish'] as const;

export interface TokenInfo {
  expiresAt: number | null;
  daysRemaining: number | null;
  valid: boolean;
  detail: string;
  scopes: string[];
  missingScopes: string[];
  /** Absent publishing scopes. Only matters when ENABLE_IG_PUBLISHING is on. */
  missingPublishingScopes: string[];
}

export async function inspectToken(token: string): Promise<TokenInfo> {
  try {
    const result = await call<{
      data: { expires_at?: number; is_valid?: boolean; scopes?: string[] };
    }>('debug_token', { token, params: { input_token: token } });

    const expiresAt = result.data.expires_at ?? null;
    const daysRemaining =
      expiresAt && expiresAt > 0
        ? Math.floor((expiresAt - Math.floor(Date.now() / 1000)) / 86400)
        : null;

    const scopes = result.data.scopes ?? [];
    // An empty scope list means debug_token didn't report them, not that the
    // token has none — don't cry wolf over a field the API left out.
    const missingScopes =
      scopes.length === 0 ? [] : REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
    const missingPublishingScopes =
      scopes.length === 0 ? [] : PUBLISHING_SCOPES.filter((s) => !scopes.includes(s));

    const expiryDetail =
      daysRemaining === null ? 'no expiry reported' : `${daysRemaining} day(s) remaining`;

    return {
      expiresAt,
      daysRemaining,
      valid: result.data.is_valid !== false,
      detail:
        missingScopes.length > 0
          ? `${expiryDetail}; missing scope(s): ${missingScopes.join(', ')}`
          : expiryDetail,
      scopes,
      missingScopes,
      missingPublishingScopes,
    };
  } catch (error) {
    return {
      expiresAt: null,
      daysRemaining: null,
      valid: false,
      detail: (error as Error).message,
      scopes: [],
      missingScopes: [],
      missingPublishingScopes: [],
    };
  }
}

/**
 * Long-lived tokens last ~60 days and can be exchanged for a fresh one at any
 * point after 24 hours. Refreshing early is free; letting one expire is not.
 */
export async function refreshLongLivedToken(token: string): Promise<string> {
  const result = await call<{ access_token: string }>('refresh_access_token', {
    token,
    params: { grant_type: 'ig_refresh_token' },
  });
  await recordRun({
    provider: 'instagram-graph',
    operation: 'refresh_token',
    status: 'ok',
    costEstimate: 0,
  });
  return result.access_token;
}
