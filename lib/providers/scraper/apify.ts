import fs from 'node:fs';
import path from 'node:path';
import { ApifyClient } from 'apify-client';
import { assertProviderAllowed } from '../guard';
import { estimateCost } from '../../ingest/budget';
import { normalizeDataset } from '../../ingest/normalize';
import { recordRun } from '../../runs/log';
import type { ProviderHealth } from '../types';
import type {
  CostEstimate,
  ScrapedPost,
  ScrapedProfile,
  ScrapeResult,
  ScraperProvider,
} from './types';

const DESCRIPTOR = {
  id: 'apify',
  kind: 'scraper' as const,
  // The free plan cannot overdraw: it stops when the credits run out. Budgeting
  // below exists to make that stop predictable rather than a surprise mid-scan.
  costsMoney: false,
  costNote: 'Apify free plan (~$5/mo of credits). Cannot overdraw; scans are budgeted.',
};

export const FIXTURE_DIR = 'fixtures';

function appUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

export interface StartedRun {
  runId: string;
  datasetId: string;
}

export interface CompletedRun {
  status: string;
  succeeded: boolean;
  items: unknown[];
}

/**
 * Fire-and-return: `start()` kicks off the actor and returns immediately —
 * nothing here blocks for the actor's runtime, which can far exceed a Vercel
 * function's duration ceiling. `fetchRun()` is called by the webhook receiver
 * once Apify reports the run finished.
 */
export class ApifyScraper implements ScraperProvider {
  readonly id = DESCRIPTOR.id;
  readonly kind = DESCRIPTOR.kind;
  readonly costsMoney = DESCRIPTOR.costsMoney;
  readonly costNote = DESCRIPTOR.costNote;
  private readonly client: ApifyClient;
  private readonly actor: string;
  private readonly hashtagActor: string;
  private readonly monthlyAllowanceUsd: number;
  private readonly webhookSecret: string | undefined;

  constructor(options: {
    token: string;
    actor: string;
    hashtagActor?: string;
    monthlyAllowanceUsd: number;
    webhookSecret?: string | undefined;
  }) {
    assertProviderAllowed(DESCRIPTOR);
    if (!options.token) {
      throw new Error('APIFY_TOKEN is empty. Get a free token at https://console.apify.com/.');
    }
    this.client = new ApifyClient({ token: options.token });
    this.actor = options.actor;
    this.hashtagActor = options.hashtagActor ?? options.actor;
    this.monthlyAllowanceUsd = options.monthlyAllowanceUsd;
    this.webhookSecret = options.webhookSecret;
  }

  async health(): Promise<ProviderHealth> {
    try {
      const user = await this.client.user('me').get();
      return { ok: true, detail: `authenticated as ${user?.username ?? 'unknown'}` };
    } catch (error) {
      return { ok: false, detail: `Apify token rejected: ${(error as Error).message}` };
    }
  }

  async estimate(request: { handle: string; limit: number }): Promise<CostEstimate> {
    return estimateCost(request.limit, this.monthlyAllowanceUsd);
  }

  /** Not used on Vercel — kept only so the interface is uniform. See `start()`. */
  async scrape(): Promise<ScrapeResult> {
    throw new Error(
      'ApifyScraper.scrape() blocks until the actor finishes, which can exceed a function timeout. ' +
        'Use start() + the /api/webhooks/apify callback instead.',
    );
  }

  /** Fires the actor and returns immediately. The webhook resumes the job on completion. */
  async start(request: { handle: string; limit: number }): Promise<StartedRun> {
    const estimate = await this.estimate(request);
    if (!estimate.affordable) {
      await recordRun({
        provider: this.id,
        operation: 'scrape',
        status: 'skipped',
        error: estimate.note,
        meta: { handle: request.handle, items: 0 },
      });
      throw new Error(`Refusing to scrape: ${estimate.note}`);
    }

    const webhookUrl = this.webhookSecret
      ? `${appUrl()}/api/webhooks/apify?secret=${encodeURIComponent(this.webhookSecret)}`
      : `${appUrl()}/api/webhooks/apify`;

    // Input shape differs per actor. These are the fields common to
    // no-cookies Instagram profile-posts actors; confirm against the actor's
    // Store page and record drift in NOTES.md.
    const run = await this.client.actor(this.actor).start(
      {
        username: [request.handle],
        resultsType: 'posts',
        resultsLimit: request.limit,
      },
      {
        webhooks: [
          {
            eventTypes: [
              'ACTOR.RUN.SUCCEEDED',
              'ACTOR.RUN.FAILED',
              'ACTOR.RUN.ABORTED',
              'ACTOR.RUN.TIMED_OUT',
            ],
            requestUrl: webhookUrl,
          },
        ],
      },
    );

    return { runId: run.id, datasetId: run.defaultDatasetId };
  }

  /**
   * Fires the hashtag-scraper actor for one hashtag. Same fire-and-return
   * shape as `start()` — used by competitor discovery, which scans several
   * hashtags per account and cannot afford to block on any of them.
   */
  async startHashtag(hashtag: string, limit: number): Promise<StartedRun> {
    const webhookUrl = this.webhookSecret
      ? `${appUrl()}/api/webhooks/apify?secret=${encodeURIComponent(this.webhookSecret)}`
      : `${appUrl()}/api/webhooks/apify`;

    const run = await this.client.actor(this.hashtagActor).start(
      { hashtags: [hashtag], resultsLimit: limit },
      {
        webhooks: [
          {
            eventTypes: [
              'ACTOR.RUN.SUCCEEDED',
              'ACTOR.RUN.FAILED',
              'ACTOR.RUN.ABORTED',
              'ACTOR.RUN.TIMED_OUT',
            ],
            requestUrl: webhookUrl,
          },
        ],
      },
    );

    return { runId: run.id, datasetId: run.defaultDatasetId };
  }

  /** Called by the webhook handler once Apify reports the run is finished. */
  async fetchRun(runId: string): Promise<CompletedRun> {
    const run = await this.client.run(runId).get();
    if (!run) throw new Error(`Apify run ${runId} not found`);
    const { items } = await this.client.dataset(run.defaultDatasetId).listItems();
    return { status: run.status, succeeded: run.status === 'SUCCEEDED', items };
  }
}

/** Normalizes a completed run's items and logs the spend. Shared by the webhook handler. */
export async function ingestCompletedRun(
  handle: string,
  run: CompletedRun,
  limit: number,
  stopAtShortcodes?: Set<string>,
): Promise<{
  profile: ScrapedProfile | null;
  posts: ScrapedPost[];
  complete: boolean;
  note: string;
}> {
  const { profile, posts } = normalizeDataset(run.items, handle);

  let kept = posts;
  let stopped = false;
  if (stopAtShortcodes?.size) {
    const index = posts.findIndex((p) => stopAtShortcodes.has(p.shortcode));
    if (index >= 0) {
      kept = posts.slice(0, index);
      stopped = true;
    }
  }

  await recordRun({
    provider: 'apify',
    operation: 'scrape',
    status: run.succeeded ? 'ok' : 'error',
    freeTier: true,
    error: run.succeeded ? null : `actor finished ${run.status}`,
    meta: { handle, items: run.items.length },
  });

  if (run.succeeded && kept.length > 0) {
    const file = writeFixture(handle, run.items);
    void file;
  }

  void limit;
  return {
    profile,
    posts: kept,
    complete: run.succeeded,
    note: run.succeeded
      ? stopped
        ? `Stopped at a known post: ${kept.length} new of ${posts.length} fetched.`
        : `${kept.length} posts.`
      : `Actor finished with status ${run.status}. Treat this scan as partial.`,
  };
}

/**
 * The first successful live response for an account is written to ./fixtures/
 * so the whole pipeline can be replayed offline forever after. Best-effort:
 * Vercel's filesystem is read-only outside /tmp, so this only actually
 * persists in local development — that's fine, it's a dev convenience.
 */
export function writeFixture(handle: string, raw: unknown): string | null {
  try {
    const dir = path.join(process.cwd(), FIXTURE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${handle.toLowerCase()}.json`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    }
    return file;
  } catch {
    return null;
  }
}

export function fixturePath(handle: string): string {
  return path.join(process.cwd(), FIXTURE_DIR, `${handle.toLowerCase()}.json`);
}

export function hasFixture(handle: string): boolean {
  return fs.existsSync(fixturePath(handle));
}
