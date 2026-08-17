import fs from 'node:fs';
import { normalizeDataset } from '../../ingest/normalize';
import { recordRun } from '../../runs/log';
import type { ProviderHealth } from '../types';
import type { CostEstimate, ScrapeRequest, ScrapeResult, ScraperProvider } from './types';
import { fixturePath, hasFixture } from './apify';

/**
 * Replays a saved actor response. This is the default development mode: it runs
 * the entire pipeline — normalisation included — at zero credit cost and with
 * no network access, which is what makes iterating on the analysis affordable.
 *
 * It deliberately re-runs `normalizeDataset` rather than storing normalised
 * output, so a normalisation bug is caught here rather than after a live scrape.
 */
export class FixtureScraper implements ScraperProvider {
  readonly id = 'fixture';
  readonly kind = 'scraper' as const;
  readonly costsMoney = false;
  readonly costNote = 'Replays ./fixtures. No network, no credits.';

  async health(): Promise<ProviderHealth> {
    const dir = fixturePath('').replace(/[^/\\]*$/, '');
    if (!fs.existsSync(dir)) {
      return { ok: false, detail: 'No ./fixtures directory yet — run one live scan to create it.' };
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    return files.length > 0
      ? {
          ok: true,
          detail: `${files.length} fixture(s): ${files.map((f) => f.replace('.json', '')).join(', ')}`,
        }
      : { ok: false, detail: 'No fixtures saved yet. Run one live scan with SCRAPE_MODE=live.' };
  }

  async estimate(request: { handle: string; limit: number }): Promise<CostEstimate> {
    return {
      items: request.limit,
      costUsd: 0,
      remainingAfterUsd: Number.POSITIVE_INFINITY,
      affordable: true,
      note: hasFixture(request.handle)
        ? 'Replaying a saved fixture. No credits are spent.'
        : `No fixture for @${request.handle}. Scan it once with SCRAPE_MODE=live first.`,
    };
  }

  async scrape(request: ScrapeRequest): Promise<ScrapeResult> {
    const file = fixturePath(request.handle);
    if (!fs.existsSync(file)) {
      throw new Error(
        `No fixture for @${request.handle} at ${file}. Run one live scan (SCRAPE_MODE=live) to create it, ` +
          `or switch SCRAPE_MODE=fake to use synthetic data.`,
      );
    }

    const items = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown[];
    const list = Array.isArray(items) ? items : [items];
    request.onProgress?.(list.length, `replaying ${list.length} fixture items`);

    const { profile, posts } = normalizeDataset(list, request.handle);

    let kept = posts.slice(0, request.limit);
    let stopped = false;
    if (request.stopAtShortcodes?.size) {
      const index = kept.findIndex((p) => request.stopAtShortcodes!.has(p.shortcode));
      if (index >= 0) {
        kept = kept.slice(0, index);
        stopped = true;
      }
    }

    await recordRun({
      provider: this.id,
      operation: 'scrape',
      status: 'ok',
      costEstimate: 0,
      meta: { handle: request.handle, items: 0, fixture: true },
    });

    return {
      profile,
      posts: kept,
      complete: true,
      note: stopped
        ? `Fixture replay stopped at a known post: ${kept.length} new.`
        : `Fixture replay: ${kept.length} posts.`,
      itemsCharged: 0,
      costEstimateUsd: 0,
      raw: list,
    };
  }
}
