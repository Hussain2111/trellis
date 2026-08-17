import { assertProviderAllowed } from '../guard';
import type { ProviderHealth } from '../types';
import type { BackgroundRequest, BackgroundResult, ImageProvider } from './types';

const DESCRIPTOR = {
  id: 'pollinations',
  kind: 'image' as const,
  costsMoney: false,
  costNote: 'Free public endpoint. No key, no account, no SLA.',
};

/**
 * Free, keyless, and entirely unpromised — rate limits change without notice
 * and the service goes down. Every call is treated as failable: a failure
 * returns the gradient fallback rather than blocking a draft.
 */
export class PollinationsImageProvider implements ImageProvider {
  readonly id = DESCRIPTOR.id;
  readonly kind = DESCRIPTOR.kind;
  readonly costsMoney = DESCRIPTOR.costsMoney;
  readonly costNote = DESCRIPTOR.costNote;
  private readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    assertProviderAllowed(DESCRIPTOR);
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, detail: 'no health endpoint; failures degrade to a gradient' };
  }

  async background(request: BackgroundRequest): Promise<BackgroundResult> {
    const url = new URL(
      `https://image.pollinations.ai/prompt/${encodeURIComponent(request.prompt)}`,
    );
    url.searchParams.set('width', String(request.width));
    url.searchParams.set('height', String(request.height));
    url.searchParams.set('nologo', 'true');
    if (request.seed !== undefined) url.searchParams.set('seed', String(request.seed));

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) return this.degrade(`responded ${res.status}`);
      const buffer = new Uint8Array(await res.arrayBuffer());
      if (buffer.byteLength < 1024) return this.degrade('response too small to be an image');
      return { bytes: buffer, provider: this.id, fallback: false, note: 'pollinations background' };
    } catch (error) {
      return this.degrade((error as Error).message);
    }
  }

  private degrade(reason: string): BackgroundResult {
    return {
      bytes: null,
      provider: this.id,
      fallback: true,
      note: `Pollinations unavailable (${reason}) — using a palette gradient instead.`,
    };
  }
}
