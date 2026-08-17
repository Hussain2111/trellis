import { z } from 'zod';
import type { Pattern } from '../analysis/patterns';

export const gapAnalysisSchema = z.object({
  claims: z
    .array(
      z.object({
        key: z.string(),
        claim: z.string().min(15).max(280),
      }),
    )
    .min(1),
});

export type GapAnalysisResult = z.infer<typeof gapAnalysisSchema>;

export const GAP_ANALYSIS_SYSTEM = `You write one plain-English sentence per pattern, using ONLY the numbers
given — never invent, round differently, or estimate a number that isn't in
the input. Each sentence should read like a coach pointing at a stat, e.g.
"58% of your niche's top reels open with a question, you use one 12% of the
time." Reply with ONLY a JSON object, no prose, no code fences:
{"claims": [{"key": string, "claim": string}, ...]} — one entry per pattern, in the same order.`;

export function buildGapAnalysisPrompt(patterns: Pattern[]): string {
  const lines = patterns.map(
    (p, i) =>
      `${i + 1}. key="${p.key}" — "${p.name}": ${(p.nicheStat * 100).toFixed(0)}% of top niche performers (n=${p.nicheSampleSize}) vs ${(p.myStat * 100).toFixed(0)}% of your posts (n=${p.mySampleSize}). Delta: ${p.deltaPct.toFixed(0)} points.`,
  );
  return `Patterns:\n${lines.join('\n')}`;
}
