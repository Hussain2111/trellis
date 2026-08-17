import { z } from 'zod';
import type { Prompt } from './index';

/**
 * The "is this thing plugged in" prompt, used by the Settings test buttons.
 * Tiny on purpose: on Tier B it must fit well inside the prompt ceiling, and it
 * doubles as a check that grammar-constrained output actually works locally.
 */

export const smokeSchema = z.object({
  ok: z.boolean(),
  mood: z.enum(['ready', 'tired', 'confused']),
});

export type SmokeResult = z.infer<typeof smokeSchema>;

const SHARED_VARS = {} as const;
export type SmokeVars = typeof SHARED_VARS;

export const smokeTierA: Prompt<SmokeVars, SmokeResult> = {
  id: 'smoke',
  version: 1,
  tier: 'A',
  system:
    'You are a connection test for a local Instagram coaching tool. Answer with JSON only, no prose.',
  render: () =>
    'Reply with {"ok": true, "mood": "ready"} to confirm you can produce valid structured output.',
  schema: smokeSchema,
};

export const smokeTierB: Prompt<SmokeVars, SmokeResult> = {
  id: 'smoke',
  version: 1,
  tier: 'B',
  system: 'Answer with JSON only.',
  render: () => 'Set ok to true and mood to "ready".',
  schema: smokeSchema,
};
