import { createOllama } from 'ollama-ai-provider-v2';
import { embedMany, generateText, jsonSchema, type JSONValue } from 'ai';
import { z } from 'zod';
import { assertProviderAllowed } from '../guard';
import type { ProviderHealth } from '../types';
import type { CompleteRequest, EmbeddingProvider, EmbedResult, LlmProvider } from './types';
import { estimateRequestTokens } from './tokens';

/**
 * Tier B. Local, unlimited, and slow at prefill — which is why the router
 * refuses anything long. Its real job is embeddings.
 */

const DESCRIPTOR = {
  id: 'ollama',
  kind: 'llm' as const,
  costsMoney: false,
  costNote: 'Local inference. Electricity only.',
};

function client(baseURL: string) {
  return createOllama({ baseURL: `${baseURL.replace(/\/$/, '')}/api` });
}

export class OllamaLlm implements LlmProvider {
  readonly id = DESCRIPTOR.id;
  readonly kind = DESCRIPTOR.kind;
  readonly costsMoney = DESCRIPTOR.costsMoney;
  readonly costNote = DESCRIPTOR.costNote;
  readonly tier = 'B' as const;
  readonly model: string;
  private readonly baseURL: string;
  private readonly keepAlive: string;

  constructor(options: { baseURL: string; model: string; keepAlive?: string }) {
    assertProviderAllowed(DESCRIPTOR);
    if (!options.model) {
      throw new Error(
        'OLLAMA_MODEL is empty. Run `npm run bench:llm` and set it to whatever the benchmark says is fast enough here.',
      );
    }
    this.baseURL = options.baseURL;
    this.model = options.model;
    this.keepAlive = options.keepAlive ?? '5m';
  }

  async health(): Promise<ProviderHealth> {
    try {
      const res = await fetch(`${this.baseURL}/api/tags`);
      if (!res.ok) return { ok: false, detail: `Ollama responded ${res.status}` };
      const body = (await res.json()) as { models?: { name: string }[] };
      const names = (body.models ?? []).map((m) => m.name);
      const present = names.some((n) => n === this.model || n.startsWith(`${this.model}:`));
      return present
        ? { ok: true, detail: `${this.model} available` }
        : { ok: false, detail: `${this.model} not pulled. Run: ollama pull ${this.model}` };
    } catch {
      return { ok: false, detail: `No Ollama at ${this.baseURL}. Is it running?` };
    }
  }

  async complete(request: CompleteRequest<unknown>): Promise<{
    text: string;
    promptTokens?: number;
    completionTokens?: number;
  }> {
    const ollama = client(this.baseURL);
    const providerOptions = { ollama: { keep_alive: this.keepAlive } as Record<string, JSONValue> };

    // Local models are unreliable at free-form JSON, so structured requests go
    // through Ollama's grammar-constrained mode rather than a "reply with JSON"
    // instruction.
    const format = request.schema
      ? jsonSchema(z.toJSONSchema(request.schema) as Record<string, unknown>)
      : undefined;

    const result = await generateText({
      model: ollama(this.model),
      system: request.system ?? '',
      prompt: request.prompt,
      temperature: request.temperature ?? 0,
      maxOutputTokens: request.maxOutputTokens ?? 512,
      providerOptions: format
        ? {
            ollama: {
              ...providerOptions.ollama,
              format: format.jsonSchema as JSONValue,
            },
          }
        : providerOptions,
    });

    const out: { text: string; promptTokens?: number; completionTokens?: number } = {
      text: result.text,
    };
    if (result.usage?.inputTokens !== undefined) out.promptTokens = result.usage.inputTokens;
    if (result.usage?.outputTokens !== undefined) out.completionTokens = result.usage.outputTokens;
    return out;
  }
}

export class OllamaEmbeddings implements EmbeddingProvider {
  readonly id = 'ollama-embed';
  readonly kind = 'embedding' as const;
  readonly costsMoney = false;
  readonly costNote = 'Local embeddings. Free.';
  readonly model: string;
  private readonly baseURL: string;

  constructor(options: { baseURL: string; model: string }) {
    assertProviderAllowed({ ...DESCRIPTOR, id: this.id, kind: 'embedding' });
    this.baseURL = options.baseURL;
    this.model = options.model;
  }

  async health(): Promise<ProviderHealth> {
    try {
      const res = await fetch(`${this.baseURL}/api/tags`);
      if (!res.ok) return { ok: false, detail: `Ollama responded ${res.status}` };
      const body = (await res.json()) as { models?: { name: string }[] };
      const present = (body.models ?? []).some(
        (m) => m.name === this.model || m.name.startsWith(`${this.model}:`),
      );
      return present
        ? { ok: true, detail: `${this.model} available` }
        : { ok: false, detail: `${this.model} not pulled. Run: ollama pull ${this.model}` };
    } catch {
      return { ok: false, detail: `No Ollama at ${this.baseURL}. Is it running?` };
    }
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], model: this.model, dim: 0 };
    const ollama = client(this.baseURL);
    const { embeddings } = await embedMany({
      model: ollama.textEmbeddingModel(this.model),
      values: texts,
    });
    const vectors = embeddings.map((e) => Float32Array.from(e));
    return { vectors, model: this.model, dim: vectors[0]?.length ?? 0 };
  }
}

/** Exposed for the benchmark, which needs raw timings rather than SDK niceties. */
export async function rawGenerate(options: {
  baseURL: string;
  model: string;
  prompt: string;
  numPredict: number;
  keepAlive: string;
}): Promise<{
  promptEvalCount: number;
  promptEvalDurationNs: number;
  evalCount: number;
  evalDurationNs: number;
  totalDurationNs: number;
}> {
  const res = await fetch(`${options.baseURL.replace(/\/$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: options.model,
      prompt: options.prompt,
      stream: false,
      keep_alive: options.keepAlive,
      options: { num_predict: options.numPredict, temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama /api/generate responded ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as Record<string, number>;
  return {
    promptEvalCount: body.prompt_eval_count ?? 0,
    promptEvalDurationNs: body.prompt_eval_duration ?? 0,
    evalCount: body.eval_count ?? 0,
    evalDurationNs: body.eval_duration ?? 0,
    totalDurationNs: body.total_duration ?? 0,
  };
}

export function estimateOllamaPromptTokens(request: CompleteRequest<unknown>): number {
  return estimateRequestTokens([request.system, request.prompt]);
}
