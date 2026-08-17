import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';
import { assertProviderAllowed } from '../guard';
import { recordObservedLimit, type JobType as QuotaJobType } from '../../quota/budget';
import type { ProviderHealth } from '../types';
import type { CompleteRequest, LlmProvider } from './types';

/**
 * Tier A. Google AI Studio's free tier — no credit card, so the key genuinely
 * cannot bill. Published limits move constantly (they were cut in Dec 2025 and
 * again in 2026), so nothing here assumes a number: limits are read from
 * response headers when present and otherwise learned from 429s.
 */

const DESCRIPTOR = {
  id: 'google',
  kind: 'llm' as const,
  costsMoney: false,
  costNote: 'Google AI Studio free tier. No credit card attached, so it cannot bill.',
};

export class GoogleLlm implements LlmProvider {
  readonly id = DESCRIPTOR.id;
  readonly kind = DESCRIPTOR.kind;
  readonly costsMoney = DESCRIPTOR.costsMoney;
  readonly costNote = DESCRIPTOR.costNote;
  readonly tier = 'A' as const;
  readonly model: string;
  private readonly apiKey: string;

  constructor(options: { apiKey: string; model: string }) {
    assertProviderAllowed(DESCRIPTOR);
    if (!options.apiKey) {
      throw new Error(
        'GOOGLE_GENERATIVE_AI_API_KEY is empty. Get a free key at https://aistudio.google.com/apikey (no card required).',
      );
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
  }

  async health(): Promise<ProviderHealth> {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`,
      );
      if (res.status === 429) return { ok: false, detail: 'Rate limited right now' };
      if (!res.ok) return { ok: false, detail: `AI Studio responded ${res.status}` };
      const body = (await res.json()) as { models?: { name: string }[] };
      const names = (body.models ?? []).map((m) => m.name.replace(/^models\//, ''));
      return names.includes(this.model)
        ? { ok: true, detail: `${this.model} available` }
        : {
            ok: false,
            detail: `${this.model} not in the model list — it may have been retired. Available: ${names.slice(0, 6).join(', ')}`,
          };
    } catch (error) {
      return { ok: false, detail: `Could not reach AI Studio: ${(error as Error).message}` };
    }
  }

  async complete(request: CompleteRequest<unknown>): Promise<{
    text: string;
    promptTokens?: number;
    completionTokens?: number;
  }> {
    const google = createGoogleGenerativeAI({ apiKey: this.apiKey });

    const result = await generateText({
      model: google(this.model),
      system: request.system ?? '',
      prompt: request.prompt,
      temperature: request.temperature ?? 0.4,
      maxOutputTokens: request.maxOutputTokens ?? 4096,
      ...(request.schema
        ? {
            providerOptions: {
              google: { responseModalities: ['TEXT'] },
            },
          }
        : {}),
      onStepFinish: ({ response }) => {
        observeRateLimitHeaders(response.headers, request.operation);
      },
    });

    const out: { text: string; promptTokens?: number; completionTokens?: number } = {
      text: result.text,
    };
    if (result.usage?.inputTokens !== undefined) out.promptTokens = result.usage.inputTokens;
    if (result.usage?.outputTokens !== undefined) out.completionTokens = result.usage.outputTokens;
    return out;
  }
}

const QUOTA_JOB_TYPES = new Set<string>([
  'cluster_naming',
  'gap_analysis',
  'voice_profile',
  'draft_generation',
  'chat',
  'misc',
]);

/**
 * Persist whatever the provider tells us about its own limits. Google does not
 * currently send standard rate-limit headers on every response, so this is
 * best-effort by design — when nothing is there, we simply learn nothing and
 * keep relying on 429 handling.
 */
export function observeRateLimitHeaders(
  headers: Record<string, string> | undefined,
  operation: string,
): void {
  if (!headers) return;
  const candidates = [
    'x-ratelimit-limit-requests',
    'x-ratelimit-limit',
    'ratelimit-limit',
    'x-goog-quota-limit',
  ];
  for (const key of candidates) {
    const value = headers[key];
    if (!value) continue;
    const limit = Number.parseInt(value, 10);
    if (Number.isFinite(limit) && limit > 0) {
      const jobType = (QUOTA_JOB_TYPES.has(operation) ? operation : 'misc') as QuotaJobType;
      recordObservedLimit('google', jobType, limit);
      return;
    }
  }
}
