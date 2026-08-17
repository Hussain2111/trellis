import { z } from 'zod';
import type { Prompt } from './index';

/**
 * The headline call. Input is the compact aggregate table — never the corpus.
 *
 * Every claim must carry its numbers and its receipts, because the numbers are
 * then checked back against Layer A. That reconciliation is what makes a cheap
 * model safe to rely on: the arithmetic is trustworthy regardless of who wrote
 * the sentence around it.
 */

export const patternSchema = z.object({
  claim: z.string().min(10).max(240),
  niche_stat: z.string().min(1).max(80),
  my_stat: z.string().min(1).max(80),
  delta: z.string().min(1).max(80),
  evidence: z.array(z.number().int()).min(1),
});

export const gapSchema = patternSchema.extend({
  why_this_one: z.string().min(20).max(400),
});

export const gapAnalysisSchema = z.object({
  patterns: z.array(patternSchema).length(5),
  gap: gapSchema,
});

export type GapAnalysis = z.infer<typeof gapAnalysisSchema>;
export type Pattern = z.infer<typeof patternSchema>;
export type Gap = z.infer<typeof gapSchema>;

export interface GapAnalysisVars {
  aggregate: string;
  windowDays: number;
}

const SYSTEM = `You are a blunt, numerate Instagram coach speaking directly to one creator. First person. Opinionated. You are not a dashboard.

You are given aggregate statistics — already computed, already correct. Your job is to say what they mean, not to recompute them.

Hard rules:
1. Every claim cites numbers that appear VERBATIM in the input. Never invent, round differently, or estimate a statistic.
2. Every claim lists post_ids in "evidence" drawn ONLY from the input. If you cannot point at specific posts, do not make the claim.
3. "niche_stat" and "my_stat" are short strings like "51% of top posts" and "20% of yours". "delta" states the gap, e.g. "31 points behind".
4. Pick the ONE gap that would move the needle most, and say why that one and not the others. Favour a gap that is (a) large, (b) about something that measurably wins in this niche, and (c) actually fixable by changing what gets posted.
5. If the input warns that the competitor pool is thin, say so in the gap's reasoning rather than pretending to certainty.
6. Speak like a person: "You're posting carousels into a niche where reels are doing three times the work." Not "Carousel utilisation is suboptimal."
7. JSON only.`;

export const gapAnalysis: Prompt<GapAnalysisVars, GapAnalysis> = {
  id: 'gap-analysis',
  version: 1,
  tier: 'A',
  system: SYSTEM,
  schema: gapAnalysisSchema,
  render: (vars) =>
    [
      `Analysis window: last ${vars.windowDays} days.`,
      '',
      '=== AGGREGATES ===',
      vars.aggregate,
      '=== END AGGREGATES ===',
      '',
      'Return JSON:',
      '{"patterns":[{"claim":"...","niche_stat":"...","my_stat":"...","delta":"...","evidence":[post_id,...]} x5],',
      ' "gap":{"claim":"...","niche_stat":"...","my_stat":"...","delta":"...","evidence":[post_id,...],"why_this_one":"..."}}',
      '',
      'Exactly 5 patterns. Exactly 1 gap. Every post_id must appear in the aggregates above.',
    ].join('\n'),
};
