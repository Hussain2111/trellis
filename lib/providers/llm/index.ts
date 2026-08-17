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
import { FakeLlm } from './fake';
import {
  QuotaExhausted,
  type CompleteRequest,
  type CompleteResult,
  type LlmProvider,
} from './types';

export * from './types';
export { FakeLlm } from './fake';

let provider: LlmProvider | null = null;

/** Test seam: swap in a fake without touching the environment. */
export function __setLlmForTests(value: LlmProvider | null): void {
  provider = value;
}

export function getLlm(): LlmProvider {
  if (provider) return provider;
  const e = env();
  provider =
    e.LLM_PROVIDER === 'fake'
      ? new FakeLlm()
      : new GoogleLlm({ apiKey: e.GOOGLE_GENERATIVE_AI_API_KEY ?? '', model: e.GOOGLE_MODEL });
  return provider;
}

function quotaJobType(operation: string): QuotaJobType {
  const known: QuotaJobType[] = [
    'niche_inference',
    'hook_classification',
    'gap_analysis',
    'voice_profile',
    'draft_generation',
    'chat',
  ];
  return known.includes(operation as QuotaJobType) ? (operation as QuotaJobType) : 'misc';
}

/**
 * The one entry point for generation. Resolves the provider, checks the
 * self-imposed daily budget for this job type, spends it, and records to
 * `runs`. There is only one tier — Gemini free tier — so quota exhaustion is
 * a hard stop (the caller's job should requeue for tomorrow), not a fallback.
 */
export async function complete<T = string>(
  request: CompleteRequest<T>,
): Promise<CompleteResult<T>> {
  const llm = getLlm();
  const headroom = await checkHeadroom(llm.id, quotaJobType(request.operation));

  if (!headroom.allowed) {
    await recordRun({
      provider: llm.id,
      model: llm.model,
      operation: request.operation,
      status: 'skipped',
      error: headroom.reason ?? 'no headroom',
    });
    throw new QuotaExhausted('daily');
  }

  const started = Date.now();
  const generatedBy = `${llm.id}:${llm.model}`;

  const attempt = async (
    req: CompleteRequest<unknown>,
  ): Promise<{ text: string; promptTokens?: number; completionTokens?: number }> =>
    llm.complete(req);

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

    await consume(llm.id, quotaJobType(request.operation));

    const durationMs = Date.now() - started;
    await recordRun({
      provider: llm.id,
      model: llm.model,
      operation: request.operation,
      status: 'ok',
      costEstimate: 0,
      freeTier: true,
      promptTokens: raw.promptTokens ?? null,
      completionTokens: raw.completionTokens ?? null,
      durationMs,
    });

    const out: CompleteResult<T> = { value, generatedBy, durationMs };
    if (raw.promptTokens !== undefined) out.promptTokens = raw.promptTokens;
    if (raw.completionTokens !== undefined) out.completionTokens = raw.completionTokens;
    return out;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const quota = classifyQuotaError(error);

    await recordRun({
      provider: llm.id,
      model: llm.model,
      operation: request.operation,
      status: quota.kind === 'none' ? 'error' : 'quota',
      durationMs: Date.now() - started,
      error: message,
    });

    if (quota.kind === 'daily') {
      await markDailyExhausted(
        llm.id,
        quota.retryAfterS ? new Date(Date.now() + quota.retryAfterS * 1000) : undefined,
      );
    }
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
