import fs from 'node:fs';
import path from 'node:path';
import { ApifyClient } from 'apify-client';
import { assertProviderAllowed } from '../guard';
import { estimateCost } from '../../ingest/budget';
import { normalizeDataset } from '../../ingest/normalize';
import { recordRun } from '../../runs/log';
import type { ProviderHealth } from '../types';
import type { CostEstimate, ScrapeRequest, ScrapeResult, ScraperProvider } from './types';

const DESCRIPTOR = {
  id: 'apify',
  kind: 'scraper' as const,
  // The free plan cannot overdraw: it stops when the credits run out. Budgeting
  // below exists to make that stop predictable rather than a surprise mid-scan.
  costsMoney: false,
  costNote: 'Apify free plan (~$5/mo of credits). Cannot overdraw; scans are budgeted.',
};

export const FIXTURE_DIR = 'fixtures';

export class ApifyScraper implements ScraperProvider {
  readonly id = DESCRIPTOR.id;
  readonly kind = DESCRIPTOR.kind;
  readonly costsMoney = DESCRIPTOR.costsMoney;
  readonly costNote = DESCRIPTOR.costNote;
  private readonly client: ApifyClient;
  private readonly actor: string;
  private readonly monthlyAllowanceUsd: number;

  constructor(options: { token: string; actor: string; monthlyAllowanceUsd: number }) {
    assertProviderAllowed(DESCRIPTOR);
    if (!options.token) {
      throw new Error('APIFY_TOKEN is empty. Get a free token at https://console.apify.com/.');
    }
    this.client = new ApifyClient({ token: options.token });
    this.actor = options.actor;
    this.monthlyAllowanceUsd = options.monthlyAllowanceUsd;
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

  async scrape(request: ScrapeRequest): Promise<ScrapeResult> {
    const estimate = await this.estimate(request);
    if (!estimate.affordable) {
      recordRun({
        provider: this.id,
        operation: 'scrape',
        status: 'skipped',
        error: estimate.note,
        meta: { handle: request.handle, items: 0 },
      });
      throw new Error(`Refusing to scrape: ${estimate.note}`);
    }

    const started = Date.now();
    request.onProgress?.(0, `starting ${this.actor}`);

    try {
      // Input shape differs per actor. These are the fields common to
      // apify/instagram-scraper and the no-cookies profile actors; confirm
      // against the actor's Store page and record drift in NOTES.md.
      const run = await this.client.actor(this.actor).call({
        directUrls: [`https://www.instagram.com/${request.handle}/`],
        username: [request.handle],
        resultsType: 'posts',
        resultsLimit: request.limit,
        addParentData: true,
        // Newest-first is what makes incremental scanning cheap.
        onlyPostsNewerThan: undefined,
      });

      const { items } = await this.client.dataset(run.defaultDatasetId).listItems();
      request.onProgress?.(items.length, `fetched ${items.length} items`);

      const { profile, posts } = normalizeDataset(items, request.handle);

      // Stop at the first already-known shortcode. Items come newest-first, so
      // everything after it is already in the database.
      let kept = posts;
      let stopped = false;
      if (request.stopAtShortcodes?.size) {
        const index = posts.findIndex((p) => request.stopAtShortcodes!.has(p.shortcode));
        if (index >= 0) {
          kept = posts.slice(0, index);
          stopped = true;
        }
      }

      const itemsCharged = items.length;
      const costEstimateUsd = estimate.costUsd * (itemsCharged / Math.max(request.limit, 1));

      recordRun({
        provider: this.id,
        model: this.actor,
        operation: 'scrape',
        status: run.status === 'SUCCEEDED' ? 'ok' : 'error',
        costEstimate: costEstimateUsd,
        freeTier: true,
        durationMs: Date.now() - started,
        error: run.status === 'SUCCEEDED' ? null : `actor finished ${run.status}`,
        meta: { handle: request.handle, items: itemsCharged, runId: run.id },
      });

      return {
        profile,
        posts: kept,
        // An actor that didn't succeed is partial data, and partial data is a
        // normal state here — it just must never be rendered as complete.
        complete: run.status === 'SUCCEEDED',
        note:
          run.status === 'SUCCEEDED'
            ? stopped
              ? `Stopped at a known post: ${kept.length} new of ${posts.length} fetched.`
              : `${kept.length} posts.`
            : `Actor finished with status ${run.status}. Treat this scan as partial.`,
        itemsCharged,
        costEstimateUsd,
        raw: items,
      };
    } catch (error) {
      recordRun({
        provider: this.id,
        model: this.actor,
        operation: 'scrape',
        status: 'error',
        durationMs: Date.now() - started,
        error: (error as Error).message,
        meta: { handle: request.handle, items: 0 },
      });
      throw error;
    }
  }
}

/**
 * The first successful live response for an account is written to ./fixtures/
 * so the whole pipeline can be replayed offline forever after. You will iterate
 * on the analysis dozens of times and should not pay for it each time.
 */
export function writeFixture(handle: string, raw: unknown): string {
  const dir = path.join(process.cwd(), FIXTURE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${handle.toLowerCase()}.json`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  }
  return file;
}

export function fixturePath(handle: string): string {
  return path.join(process.cwd(), FIXTURE_DIR, `${handle.toLowerCase()}.json`);
}

export function hasFixture(handle: string): boolean {
  return fs.existsSync(fixturePath(handle));
}
