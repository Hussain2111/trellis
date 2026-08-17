import type { ProviderHealth } from '../types';
import type { BackgroundRequest, BackgroundResult, ImageProvider } from './types';

/**
 * The default. Returns no bytes, which tells the renderer to draw a gradient
 * from the curated palette. The app is fully usable in this mode — that is the
 * point of it being the default.
 */
export class NoneImageProvider implements ImageProvider {
  readonly id = 'none';
  readonly kind = 'image' as const;
  readonly costsMoney = false;
  readonly costNote = 'Deterministic gradients. No model, no network.';

  async health(): Promise<ProviderHealth> {
    return { ok: true, detail: 'gradients only — always available' };
  }

  async background(_request: BackgroundRequest): Promise<BackgroundResult> {
    return {
      bytes: null,
      provider: this.id,
      fallback: true,
      note: 'IMAGE_PROVIDER=none — slide uses a palette gradient.',
    };
  }
}
