import { z } from 'zod';
import type { ProviderHealth } from '../types';
import type {
  CompleteRequest,
  EmbeddingProvider,
  EmbedResult,
  LlmProvider,
  Tier,
} from './types';

/**
 * Deterministic stand-ins so the whole pipeline runs offline with zero network
 * calls. Not "mocks with canned strings" — these produce shape-correct output
 * for any schema, which is what lets the analysis layer be tested end to end.
 */

export class FakeLlm implements LlmProvider {
  readonly id: string;
  readonly kind = 'llm' as const;
  readonly costsMoney = false;
  readonly costNote = 'Fake provider. No network, no cost.';
  readonly tier: Tier;
  readonly model: string;
  /** Every request this fake saw — assertions read it. */
  readonly calls: CompleteRequest<unknown>[] = [];
  private queued: string[] = [];

  constructor(options: { tier?: Tier; model?: string; id?: string } = {}) {
    this.tier = options.tier ?? 'A';
    this.model = options.model ?? 'fake-1';
    this.id = options.id ?? 'fake';
  }

  /** Force the next response(s), for testing repair paths and bad output. */
  queue(...responses: string[]): void {
    this.queued.push(...responses);
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, detail: 'fake provider is always healthy' };
  }

  async complete(request: CompleteRequest<unknown>): Promise<{
    text: string;
    promptTokens: number;
    completionTokens: number;
  }> {
    this.calls.push(request);
    const queued = this.queued.shift();
    const text = queued ?? (request.schema ? JSON.stringify(sample(request.schema)) : echo(request));
    return {
      text,
      promptTokens: Math.ceil((request.prompt.length + (request.system?.length ?? 0)) / 4),
      completionTokens: Math.ceil(text.length / 4),
    };
  }
}

export class FakeEmbeddings implements EmbeddingProvider {
  readonly id = 'fake-embed';
  readonly kind = 'embedding' as const;
  readonly costsMoney = false;
  readonly costNote = 'Fake embeddings. No network, no cost.';
  readonly model = 'fake-embed-768';
  readonly dim: number;

  constructor(dim = 768) {
    this.dim = dim;
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, detail: 'fake provider is always healthy' };
  }

  /**
   * Hash-based pseudo-embeddings: stable across runs, and similar strings land
   * near each other often enough that clustering tests are meaningful.
   */
  async embed(texts: string[]): Promise<EmbedResult> {
    const vectors = texts.map((text) => {
      const v = new Float32Array(this.dim);
      const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
      for (const token of tokens) {
        const h = hash(token);
        v[h % this.dim] = (v[h % this.dim] ?? 0) + 1;
        v[(h >>> 8) % this.dim] = (v[(h >>> 8) % this.dim] ?? 0) + 0.5;
      }
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
      return v;
    });
    return { vectors, model: this.model, dim: this.dim };
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function echo(request: CompleteRequest<unknown>): string {
  return `[fake:${request.operation}] ${request.prompt.slice(0, 120)}`;
}

/** Build a minimal value satisfying a zod schema, so validation always passes. */
function sample(schema: z.ZodType<unknown>, depth = 0): unknown {
  if (depth > 6) return null;
  const def = (schema as unknown as { def: { type: string } }).def;

  switch (def.type) {
    case 'string':
      return 'fake';
    case 'number':
    case 'int':
      return 1;
    case 'boolean':
      return true;
    case 'literal':
      return (schema as unknown as { def: { values: unknown[] } }).def.values[0];
    case 'enum': {
      const entries = (schema as unknown as { def: { entries: Record<string, unknown> } }).def
        .entries;
      return Object.values(entries)[0];
    }
    case 'array': {
      const element = (schema as unknown as { def: { element: z.ZodType<unknown> } }).def.element;
      const checks = (schema as unknown as { def: { checks?: { _zod: { def: { minimum?: number } } }[] } })
        .def.checks;
      const min = checks?.find((c) => c._zod.def.minimum !== undefined)?._zod.def.minimum ?? 1;
      return Array.from({ length: Math.max(1, min) }, () => sample(element, depth + 1));
    }
    case 'object': {
      const shape = (schema as unknown as { def: { shape: Record<string, z.ZodType<unknown>> } }).def
        .shape;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(shape)) out[key] = sample(value, depth + 1);
      return out;
    }
    case 'optional':
    case 'nullable':
    case 'default': {
      const inner = (schema as unknown as { def: { innerType: z.ZodType<unknown> } }).def.innerType;
      return sample(inner, depth + 1);
    }
    case 'union': {
      const options = (schema as unknown as { def: { options: z.ZodType<unknown>[] } }).def.options;
      return sample(options[0]!, depth + 1);
    }
    case 'record':
      return {};
    default:
      return null;
  }
}
