import { z } from 'zod';
import { env } from '../../env';
import {
  checkHeadroom,
  classifyQuotaError,
  consume,
  markDailyExhausted,
  type JobType as QuotaJobType,
} from '../../quota/budget';
import { recordRun } from '../../runs/log';
import { GoogleLlm } from './google';
import { OllamaEmbeddings, OllamaLlm } from './ollama';
import { FakeEmbeddings, FakeLlm } from './fake';
import { estimateRequestTokens } from './tokens';
import {
  QuotaExhausted,
  TierBPromptTooLarge,
  type CompleteRequest,
  type CompleteResult,
  type EmbeddingProvider,
  type LlmProvider,
  type Tier,
} from './types';

export * from './types';
export { estimateTokens } from './tokens';
export { FakeEmbeddings, FakeLlm } from './fake';

let tierA: LlmProvider | null = null;
let tierB: LlmProvider | null = null;
let embedder: EmbeddingProvider | null = null;

/** Test seam: swap in fakes without touching the environment. */
export function __setProvidersForTests(providers: {
  tierA?: LlmProvider | null;
  tierB?: LlmProvider | null;
  embedder?: EmbeddingProvider | null;
}): void {
  if ('tierA' in providers) tierA = providers.tierA ?? null;
  if ('tierB' in providers) tierB = providers.tierB ?? null;
  if ('embedder' in providers) embedder = providers.embedder ?? null;
}

export function getTierA(): LlmProvider {
  if (tierA) return tierA;
  const e = env();
  tierA =
    e.LLM_TIER_A === 'fake'
      ? new FakeLlm({ tier: 'A' })
      : new GoogleLlm({ apiKey: e.GOOGLE_GENERATIVE_AI_API_KEY ?? '', model: e.GOOGLE_MODEL });
  return tierA;
}

export function getTierB(): LlmProvider {
  if (tierB) return tierB;
  const e = env();
  tierB =
    e.LLM_TIER_B === 'fake'
      ? new FakeLlm({ tier: 'B', model: 'fake-local' })
      : new OllamaLlm({
          baseURL: e.OLLAMA_BASE_URL,
          model: e.OLLAMA_MODEL,
          keepAlive: e.OLLAMA_KEEP_ALIVE,
        });
  return tierB;
}

export function getEmbedder(): EmbeddingProvider {
  if (embedder) return embedder;
  const e = env();
  embedder =
    e.LLM_TIER_B === 'fake'
      ? new FakeEmbeddings()
      : new OllamaEmbeddings({ baseURL: e.OLLAMA_BASE_URL, model: e.OLLAMA_EMBED_MODEL });
  return embedder;
}

function quotaJobType(operation: string): QuotaJobType {
  const known: QuotaJobType[] = [
    'cluster_naming',
    'gap_analysis',
    'voice_profile',
    'draft_generation',
    'chat',
  ];
  return known.includes(operation as QuotaJobType) ? (operation as QuotaJobType) : 'misc';
}

/**
 * The one entry point for generation. It resolves tier → provider → model,
 * enforces the Tier B prompt ceiling, spends quota, records to `runs`, and
 * falls back A → B when the day's Tier A allowance is gone.
 */
export async function complete<T = string>(
  request: CompleteRequest<T>,
): Promise<CompleteResult<T>> {
  if (request.tier === 'B') return runOn<T>(getTierB(), request, 'B', false);

  const provider = getTierA();
  const headroom = checkHeadroom(provider.id, quotaJobType(request.operation));

  if (!headroom.allowed) {
    if (request.allowFallback === false) {
      throw new QuotaExhausted('daily');
    }
    recordRun({
      provider: provider.id,
      model: provider.model,
      operation: request.operation,
      tier: 'A',
      status: 'skipped',
      error: headroom.reason ?? 'no headroom',
    });
    return runOn<T>(getTierB(), request, 'B', true);
  }

  try {
    const result = await runOn<T>(provider, request, 'A', false);
    consume(provider.id, quotaJobType(request.operation));
    return result;
  } catch (error) {
    const quota = classifyQuotaError(error);
    if (quota.kind === 'none') throw error;

    if (quota.kind === 'daily') {
      markDailyExhausted(
        provider.id,
        quota.retryAfterS ? Math.floor(Date.now() / 1000) + quota.retryAfterS : undefined,
      );
    }
    if (request.allowFallback === false) {
      throw new QuotaExhausted(quota.kind, quota.retryAfterS);
    }
    return runOn<T>(getTierB(), request, 'B', true);
  }
}

async function runOn<T>(
  provider: LlmProvider,
  request: CompleteRequest<T>,
  tier: Tier,
  degraded: boolean,
): Promise<CompleteResult<T>> {
  if (tier === 'B') {
    const ceiling = env().TIER_B_MAX_PROMPT_TOKENS;
    const estimated = estimateRequestTokens([request.system, request.prompt]);
    if (estimated > ceiling) {
      recordRun({
        provider: provider.id,
        model: provider.model,
        operation: request.operation,
        tier: 'B',
        status: 'skipped',
        error: `prompt ~${estimated} tokens exceeds ceiling ${ceiling}`,
      });
      throw new TierBPromptTooLarge(estimated, ceiling, request.operation);
    }
  }

  const started = Date.now();
  const generatedBy = `${provider.id}:${provider.model}`;

  const attempt = async (
    req: CompleteRequest<unknown>,
  ): Promise<{ text: string; promptTokens?: number; completionTokens?: number }> =>
    provider.complete(req);

  try {
    let raw = await attempt(request as CompleteRequest<unknown>);
    let value: T;

    if (request.schema) {
      const first = parseStructured(raw.text, request.schema);
      if (first.ok) {
        value = first.value;
      } else {
        // One repair attempt. A second failure is a real problem worth surfacing
        // rather than burning more of the day's quota on.
        const repair = await attempt({
          ...(request as CompleteRequest<unknown>),
          prompt: repairPrompt(request.prompt, raw.text, first.error),
        });
        raw = repair;
        const second = parseStructured(repair.text, request.schema);
        if (!second.ok) {
          throw new Error(`Structured output failed schema validation twice: ${second.error}`);
        }
        value = second.value;
      }
    } else {
      value = raw.text as unknown as T;
    }

    const durationMs = Date.now() - started;
    recordRun({
      provider: provider.id,
      model: provider.model,
      operation: request.operation,
      tier,
      status: 'ok',
      costEstimate: 0,
      freeTier: true,
      promptTokens: raw.promptTokens ?? null,
      completionTokens: raw.completionTokens ?? null,
      durationMs,
      meta: degraded ? { degraded: true } : null,
    });

    const out: CompleteResult<T> = { value, generatedBy, tier, degraded, durationMs };
    if (raw.promptTokens !== undefined) out.promptTokens = raw.promptTokens;
    if (raw.completionTokens !== undefined) out.completionTokens = raw.completionTokens;
    return out;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordRun({
      provider: provider.id,
      model: provider.model,
      operation: request.operation,
      tier,
      status: classifyQuotaError(error).kind === 'none' ? 'error' : 'quota',
      durationMs: Date.now() - started,
      error: message,
    });
    throw error;
  }
}

function parseStructured<T>(
  text: string,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
  const candidate = extractJson(text);
  if (candidate === null) return { ok: false, error: 'no JSON object found in output' };
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(candidate);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${(error as Error).message}` };
  }
  const result = schema.safeParse(parsedJson);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: z.prettifyError(result.error) };
}

/** Models wrap JSON in prose and fences no matter how firmly you ask them not to. */
export function extractJson(text: string): string | null {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;

  const start = body.search(/[[{]/);
  if (start === -1) return null;

  const open = body[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

function repairPrompt(original: string, badOutput: string, error: string): string {
  return [
    original,
    '',
    '---',
    'Your previous reply did not validate:',
    error,
    '',
    'Previous reply:',
    badOutput.slice(0, 1500),
    '',
    'Reply again with ONLY the corrected JSON. No prose, no code fences.',
  ].join('\n');
}

/** Embeddings never route or fall back — they are local, free, and unlimited. */
export async function embed(texts: string[]): Promise<{
  vectors: Float32Array[];
  model: string;
  dim: number;
}> {
  const provider = getEmbedder();
  const started = Date.now();
  try {
    const result = await provider.embed(texts);
    recordRun({
      provider: provider.id,
      model: provider.model,
      operation: 'embed',
      tier: 'B',
      status: 'ok',
      durationMs: Date.now() - started,
      meta: { count: texts.length },
    });
    return result;
  } catch (error) {
    recordRun({
      provider: provider.id,
      model: provider.model,
      operation: 'embed',
      tier: 'B',
      status: 'error',
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export const llm = { complete, embed, getTierA, getTierB, getEmbedder };
