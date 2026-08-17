import type { z } from 'zod';
import type { Tier } from '../providers/llm/types';

/**
 * Prompts are versioned files, never inline template literals. When a prompt
 * changes, bump `version` and keep the old file — `runs.meta` and every stored
 * artifact reference the version that produced them, so a regression is
 * traceable to a wording change rather than a mystery.
 *
 * Tier B variants are terse and heavily constrained; Tier A variants can be
 * richer. Both live in the same file so they can't drift apart unnoticed.
 */
export interface Prompt<TVars, TOut = string> {
  readonly id: string;
  readonly version: number;
  readonly tier: Tier;
  readonly system: string;
  render(vars: TVars): string;
  readonly schema?: z.ZodType<TOut>;
}

export function promptId<T, O>(prompt: Prompt<T, O>): string {
  return `${prompt.id}@v${prompt.version}`;
}

export { smokeTierA, smokeTierB } from './smoke.v1';
