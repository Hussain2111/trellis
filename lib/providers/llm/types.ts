import type { z } from 'zod';
import type { Provider } from '../types';

export interface CompleteRequest<T = string> {
  /** Used for quota accounting. */
  operation: string;
  prompt: string;
  system?: string;
  /** When present, the call is a structured-output call and the result is parsed. */
  schema?: z.ZodType<T>;
  maxOutputTokens?: number;
  temperature?: number;
  /** Set false to make quota exhaustion throw rather than queue silently. */
  allowFallback?: boolean;
}

export interface CompleteResult<T = string> {
  value: T;
  /** e.g. "google:gemini-2.5-flash" — stored on every artifact as `generated_by`. */
  generatedBy: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs: number;
}

export interface LlmProvider extends Provider {
  readonly model: string;
  complete(request: CompleteRequest<unknown>): Promise<{
    text: string;
    promptTokens?: number;
    completionTokens?: number;
  }>;
}

export class QuotaExhausted extends Error {
  readonly kind: 'per_minute' | 'daily';
  readonly retryAfterS: number | undefined;
  constructor(kind: 'per_minute' | 'daily', retryAfterS?: number) {
    super(
      kind === 'daily'
        ? 'Daily free-tier allowance for this job type is spent. Work is queued; try again tomorrow.'
        : 'Per-minute rate limit hit; backing off.',
    );
    this.name = 'QuotaExhausted';
    this.kind = kind;
    this.retryAfterS = retryAfterS;
  }
}
