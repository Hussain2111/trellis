import { recordRun } from '../runs/log';

/**
 * Instagram Graph API publishing. Free to call, and viable for one self-owned
 * account without App Review: Standard Access covers accounts that hold a role
 * on the app. See docs/instagram-setup.md.
 *
 * Container model: create a media container, poll until FINISHED, then publish.
 * Carousels create children first, then a parent with media_type=CAROUSEL.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

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

async function call<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; token: string; params?: Record<string, string> },
): Promise<T> {
  const url = new URL(`${GRAPH}/${path}`);
  const body = new URLSearchParams({ access_token: options.token, ...(options.params ?? {}) });

  const res =
    options.method === 'POST'
      ? await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        })
      : await fetch(`${url}?${body}`);

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

  while (Date.now() < deadline) {
    const result = await call<{ status_code: string; status?: string }>(containerId, {
      token,
      params: { fields: 'status_code,status' },
    });
    options.onStatus?.(result.status_code);

    if (result.status_code === 'FINISHED') return;
    if (result.status_code === 'ERROR' || result.status_code === 'EXPIRED') {
      throw new GraphError(400, `container ${result.status_code}: ${result.status ?? 'no detail'}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`container ${containerId} did not finish within ${timeoutMs / 1000}s`);
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
    const result = await call<{ data: { quota_usage: number; config?: { quota_total?: number } }[] }>(
      `${igUserId}/content_publishing_limit`,
      { token, params: { fields: 'quota_usage,config' } },
    );
    const row = result.data[0];
    if (!row) return null;
    return { used: row.quota_usage, cap: row.config?.quota_total ?? 25 };
  } catch {
    // Not fatal — the configured cap is the fallback.
    return null;
  }
}

export interface TokenInfo {
  expiresAt: number | null;
  daysRemaining: number | null;
  valid: boolean;
  detail: string;
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

    return {
      expiresAt,
      daysRemaining,
      valid: result.data.is_valid !== false,
      detail:
        daysRemaining === null
          ? 'no expiry reported'
          : `${daysRemaining} day(s) remaining`,
    };
  } catch (error) {
    return { expiresAt: null, daysRemaining: null, valid: false, detail: (error as Error).message };
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
  recordRun({
    provider: 'instagram-graph',
    operation: 'refresh_token',
    status: 'ok',
    costEstimate: 0,
  });
  return result.access_token;
}
