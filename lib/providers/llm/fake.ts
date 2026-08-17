import { z } from 'zod';
import type { ProviderHealth } from '../types';
import type { CompleteRequest, LlmProvider } from './types';

/**
 * Deterministic stand-in so the whole pipeline runs offline with zero network
 * calls. Not "mocks with canned strings" — this produces shape-correct output
 * for any schema, which is what lets the analysis layer be tested end to end.
 */

export class FakeLlm implements LlmProvider {
  readonly id: string;
  readonly kind = 'llm' as const;
  readonly costsMoney = false;
  readonly costNote = 'Fake provider. No network, no cost.';
  readonly model: string;
  /** Every request this fake saw — assertions read it. */
  readonly calls: CompleteRequest<unknown>[] = [];
  private queued: string[] = [];

  constructor(options: { model?: string; id?: string } = {}) {
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
    const text =
      queued ?? (request.schema ? JSON.stringify(sampleSchema(request.schema)) : echo(request));
    return {
      text,
      promptTokens: Math.ceil((request.prompt.length + (request.system?.length ?? 0)) / 4),
      completionTokens: Math.ceil(text.length / 4),
    };
  }
}

function echo(request: CompleteRequest<unknown>): string {
  return `[fake:${request.operation}] ${request.prompt.slice(0, 120)}`;
}

/**
 * Build a value that satisfies a zod schema, via its JSON Schema projection.
 *
 * Going through `z.toJSONSchema` rather than poking at zod internals means the
 * constraints that actually matter here — exact array lengths, minimum string
 * lengths, enums — are all visible, so the fake produces output that passes the
 * same validation the real providers face. A fake that only satisfies the
 * *shape* would let a schema regression through untested.
 */
export function sampleSchema(schema: z.ZodType<unknown>): unknown {
  try {
    return fromJsonSchema(z.toJSONSchema(schema, { io: 'output' }) as JsonSchema);
  } catch {
    return null;
  }
}

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  format?: string;
}

function fromJsonSchema(node: JsonSchema, depth = 0): unknown {
  if (depth > 8) return null;

  if (node.const !== undefined) return node.const;
  if (node.enum?.length) return node.enum[0];

  const branch = node.anyOf ?? node.oneOf;
  if (branch?.length) {
    // Prefer a non-null branch so optional/nullable fields carry a real value.
    const preferred = branch.find((b) => b.type !== 'null') ?? branch[0]!;
    return fromJsonSchema(preferred, depth + 1);
  }
  if (node.allOf?.length) {
    return Object.assign(
      {},
      ...node.allOf.map((b) => fromJsonSchema(b, depth + 1) as object),
    ) as unknown;
  }

  const type = Array.isArray(node.type) ? node.type.find((t) => t !== 'null') : node.type;

  switch (type) {
    case 'string': {
      const min = node.minLength ?? 0;
      const base = 'fake text for offline testing';
      let out = base;
      while (out.length < min) out += ` ${base}`;
      return node.maxLength ? out.slice(0, node.maxLength) : out;
    }
    case 'integer':
    case 'number': {
      const min = node.minimum ?? 1;
      const max = node.maximum ?? Math.max(min, 1);
      return Math.min(Math.max(1, min), max);
    }
    case 'boolean':
      return true;
    case 'array': {
      const items = Array.isArray(node.items) ? node.items[0] : node.items;
      const count = Math.max(node.minItems ?? 1, 1);
      return Array.from({ length: node.maxItems ? Math.min(count, node.maxItems) : count }, () =>
        items ? fromJsonSchema(items, depth + 1) : null,
      );
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.properties ?? {})) {
        out[key] = fromJsonSchema(value, depth + 1);
      }
      return out;
    }
    case 'null':
      return null;
    default:
      return node.properties ? fromJsonSchema({ ...node, type: 'object' }, depth) : null;
  }
}
