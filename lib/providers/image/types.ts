import type { Provider } from '../types';

/**
 * Backgrounds only. Slide *text* is always rendered deterministically (satori +
 * resvg at M9) — no model touches lettering.
 *
 * There is deliberately no local diffusion provider: an Iris Xe with no
 * dedicated VRAM cannot run one, and a stub would only invite someone to try.
 */

export interface BackgroundRequest {
  prompt: string;
  width: number;
  height: number;
  /** Stable output for the same draft across regenerations. */
  seed?: number;
}

export interface BackgroundResult {
  /** PNG/JPEG bytes, or null when the provider declined and a gradient should be used. */
  bytes: Uint8Array | null;
  provider: string;
  /** True when this is the deterministic gradient fallback rather than a real image. */
  fallback: boolean;
  note: string;
}

export interface ImageProvider extends Provider {
  background(request: BackgroundRequest): Promise<BackgroundResult>;
}
