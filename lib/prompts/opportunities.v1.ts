import { z } from 'zod';
import type { OpportunitiesPayload } from '../generate/payload';

export const opportunitiesSchema = z.object({
  insights: z
    .array(
      z.object({
        finding: z.string().min(20).max(300),
        direction: z.enum(['do_more', 'do_less', 'keep']),
        action: z.string().min(10).max(240),
        postIds: z.array(z.number().int()).min(1),
      }),
    )
    .min(1)
    .max(7),
});

export type OpportunitiesResult = z.infer<typeof opportunitiesSchema>;

/**
 * The prompt asks for the number discipline, and `lib/generate/validate.ts`
 * enforces it. Both, deliberately: the instruction improves the hit rate, and
 * the code is what makes the guarantee. Never rely on the prompt alone —
 * that's a request, not a constraint.
 */
export const OPPORTUNITIES_SYSTEM = `You are an Instagram strategist reading a dataset that has already been
computed for you. Your job is interpretation and prioritisation, not arithmetic.

HARD RULES:
- Never compute, estimate, or infer a number. Every figure you write must
  appear verbatim in the JSON you were given. If you want to say something the
  numbers don't already state, say it without a number.
- Every insight must cite the postIds it rests on, drawn from the input.
- Prefer specific over safe. "Your carousels reach further than your reels" is
  useful; "post consistently" is not.
- If two insights would say the same thing, keep the stronger one and drop the
  other. Fewer, sharper insights beat filling the quota.

Reply with ONLY a JSON object, no prose, no code fences:
{"insights": [{"finding": string, "direction": "do_more"|"do_less"|"keep",
"action": string, "postIds": number[]}, ...]}

- finding: what the data shows, in one or two sentences.
- direction: whether this argues for doing more of something, less, or holding.
- action: the concrete next thing to do about it.
- postIds: the posts this rests on.`;

export function buildOpportunitiesPrompt(payload: OpportunitiesPayload): string {
  return [
    `Account: @${payload.account.handle}` +
      (payload.account.niche ? ` — niche: ${payload.account.niche}` : '') +
      (payload.account.followers ? ` — ${payload.account.followers} followers` : ''),
    `Week beginning ${payload.weekStart} (Riyadh).`,
    '',
    'Every number below was computed from the database. Use these and no others.',
    '',
    JSON.stringify(
      {
        baseline: payload.baseline,
        formats: payload.formats,
        nichePatterns: payload.patterns,
        yourPosts: payload.ownPosts,
      },
      null,
      1,
    ),
    '',
    payload.deterministic.length > 0
      ? `A deterministic pass already found these. You may sharpen, reprioritise, or ` +
        `disagree with them, but do not simply restate them:\n` +
        payload.deterministic.map((d) => `- ${d.title}: ${d.detail}`).join('\n')
      : '',
    '',
    'Return 5 or fewer insights if the data only supports that many.',
  ]
    .filter(Boolean)
    .join('\n');
}
