import { env } from '../env';
import { FakeScraper } from './scraper/fake';
import { FakeTranscriber, UnavailableTranscriber } from './transcription/fake';
import { NoneImageProvider } from './image/none';
import { PollinationsImageProvider } from './image/pollinations';
import { getEmbedder, getTierA, getTierB } from './llm';
import type { ImageProvider } from './image/types';
import type { ScraperProvider } from './scraper/types';
import type { TranscriptionProvider } from './transcription/types';
import type { ProviderDescriptor } from './types';

export { assertProviderAllowed, PaidProviderError } from './guard';
export * from './types';

/**
 * Provider resolution lives here so there is exactly one place that reads the
 * environment and decides what talks to the outside world.
 */

export function getScraper(): ScraperProvider {
  const mode = env().SCRAPE_MODE;
  if (mode === 'fake') return new FakeScraper();
  // `live` and `fixture` resolve to the Apify provider at M1; until then the
  // fake is the only honest answer.
  return new FakeScraper();
}

export function getImageProvider(): ImageProvider {
  const provider = env().IMAGE_PROVIDER;
  if (provider === 'pollinations') return new PollinationsImageProvider();
  return new NoneImageProvider();
}

export function getTranscriber(): TranscriptionProvider {
  if (!env().ENABLE_TRANSCRIPTION) {
    return new UnavailableTranscriber('ENABLE_TRANSCRIPTION=false');
  }
  // Real whisper.cpp subprocess lands at M2; the fake keeps the pipeline whole.
  return new FakeTranscriber();
}

export interface ProviderStatus extends ProviderDescriptor {
  ok: boolean;
  detail: string;
  model?: string;
}

/** Everything Settings needs to show what is wired up and what it costs. */
export async function providerStatuses(): Promise<ProviderStatus[]> {
  const entries: (() => Promise<ProviderStatus>)[] = [
    async () => describe(safe(() => getTierA()), 'Tier A (reasoning)'),
    async () => describe(safe(() => getTierB()), 'Tier B (local)'),
    async () => describe(safe(() => getEmbedder()), 'Embeddings'),
    async () => describe(safe(() => getScraper()), 'Scraping'),
    async () => describe(safe(() => getTranscriber()), 'Transcription'),
    async () => describe(safe(() => getImageProvider()), 'Images'),
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
