import type { z } from 'zod';
import type { Provider } from '../types';

export type Tier = 'A' | 'B';

export interface CompleteRequest<T = string> {
  tier: Tier;
  /** Used for quota accounting and for the Tier B prompt ceiling's error message. */
  operation: string;
  prompt: string;
  system?: string;
  /** When present, the call is a structured-output call and the result is parsed. */
  schema?: z.ZodType<T>;
  maxOutputTokens?: number;
  temperature?: number;
  /** Set false to make a Tier A failure throw rather than fall through to local. */
  allowFallback?: boolean;
}

export interface CompleteResult<T = string> {
  value: T;
  /** e.g. "google:gemini-2.5-flash" — stored on every artifact as `generated_by`. */
  generatedBy: string;
  tier: Tier;
  /** True when Tier A was asked for but Tier B answered. */
  degraded: boolean;
  promptTokens?: number;
  completionTokens?: number;
  durationMs: number;
}

export interface EmbedResult {
  vectors: Float32Array[];
  model: string;
  dim: number;
}

export interface LlmProvider extends Provider {
  readonly tier: Tier;
  readonly model: string;
  complete(request: CompleteRequest<unknown>): Promise<{
    text: string;
    promptTokens?: number;
    completionTokens?: number;
  }>;
}

export interface EmbeddingProvider extends Provider {
  readonly model: string;
  embed(texts: string[]): Promise<EmbedResult>;
}

export class TierBPromptTooLarge extends Error {
  constructor(estimated: number, ceiling: number, operation: string) {
    super(
      `Tier B prompt for "${operation}" is ~${estimated} tokens, over the ${ceiling}-token ceiling. ` +
        `On this hardware that is minutes of prefill before the first output token. ` +
        `Move the job to Tier A or restructure it to send less context.`,
    );
    this.name = 'TierBPromptTooLarge';
  }
}

export class QuotaExhausted extends Error {
  readonly kind: 'per_minute' | 'daily';
  readonly retryAfterS: number | undefined;
  constructor(kind: 'per_minute' | 'daily', retryAfterS?: number) {
    super(
      kind === 'daily'
        ? 'Tier A daily free-tier allowance is spent. Work is queued; try again tomorrow.'
        : 'Tier A per-minute rate limit hit; backing off.',
    );
    this.name = 'QuotaExhausted';
    this.kind = kind;
    this.retryAfterS = retryAfterS;
  }
}
