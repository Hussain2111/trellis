import { env } from '../env';
import { ApifyScraper } from './scraper/apify';
import { FixtureScraper } from './scraper/fixture';
import { FakeScraper } from './scraper/fake';
import type { ScraperProvider } from './scraper/types';
import type { ProviderDescriptor } from './types';

export { assertProviderAllowed, PaidProviderError } from './guard';
export * from './types';

/**
 * Provider resolution lives here so there is exactly one place that reads the
 * environment and decides what talks to the outside world.
 */

export function getScraper(): ScraperProvider {
  const e = env();
  switch (e.SCRAPE_MODE) {
    case 'fake':
      return new FakeScraper();
    case 'fixture':
      return new FixtureScraper();
    case 'live':
      return new ApifyScraper({
        token: e.APIFY_TOKEN ?? '',
        actor: e.APIFY_ACTOR,
        monthlyAllowanceUsd: e.APIFY_MONTHLY_CREDIT_USD,
        webhookSecret: e.APIFY_WEBHOOK_SECRET,
      });
  }
}

export interface ProviderStatus extends ProviderDescriptor {
  ok: boolean;
  detail: string;
  model?: string;
}

/** Everything Settings needs to show what is wired up and what it costs. */
export async function providerStatuses(): Promise<ProviderStatus[]> {
  const entries: (() => Promise<ProviderStatus>)[] = [
    async () =>
      describe(
        safe(() => getScraper()),
        'Scraping',
      ),
  ];
  return Promise.all(entries.map((fn) => fn()));
}

type Describable = {
  id: string;
  kind: ProviderDescriptor['kind'];
  costsMoney: boolean;
  costNote: string;
  model?: string;
  health(): Promise<{ ok: boolean; detail: string }>;
};

function safe(factory: () => Describable): Describable | Error {
  try {
    return factory();
  } catch (error) {
    return error as Error;
  }
}

async function describe(provider: Describable | Error, label: string): Promise<ProviderStatus> {
  if (provider instanceof Error) {
    return {
      id: label,
      kind: 'llm',
      costsMoney: false,
      costNote: '—',
      ok: false,
      detail: provider.message,
    };
  }
  let health: { ok: boolean; detail: string };
  try {
    health = await provider.health();
  } catch (error) {
    health = { ok: false, detail: (error as Error).message };
  }
  const status: ProviderStatus = {
    id: provider.id,
    kind: provider.kind,
    costsMoney: provider.costsMoney,
    costNote: provider.costNote,
    ok: health.ok,
    detail: health.detail,
  };
  if (provider.model) status.model = provider.model;
  return status;
}
