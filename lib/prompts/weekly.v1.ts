import { z } from 'zod';
import type { WeeklyPayload } from '../generate/payload';

export const weeklySchema = z.object({
  headline: z.string().min(10).max(160),
  recap: z.string().min(40).max(1200),
  trends: z.string().min(40).max(1200),
  nextWeek: z
    .array(
      z.object({
        action: z.string().min(10).max(240),
        why: z.string().min(10).max(300),
        postIds: z.array(z.number().int()),
      }),
    )
    .min(1)
    .max(4),
});

export type WeeklyResult = z.infer<typeof weeklySchema>;

export const WEEKLY_SYSTEM = `You write a short weekly read for one Instagram account, over a dataset that
has already been computed for you. Interpretation only — never arithmetic.

HARD RULES:
- Every figure you write must appear verbatim in the JSON you were given.
  Never compute a total, an average, a percentage or a difference yourself.
  If the number you want isn't in the input, make the point without it.
- Where the input says a value is null, that means "not known", not "zero".
  Never describe a null as a decline, a flat week, or an absence of activity.
- Say what happened, what it means, and what to do next week. Skip anything
  the data doesn't support — a short honest read beats a padded one.
- The next-week actions should cite postIds where they follow from specific
  posts. An action that follows from the week as a whole may cite none.

Reply with ONLY a JSON object, no prose, no code fences:
{"headline": string, "recap": string, "trends": string,
 "nextWeek": [{"action": string, "why": string, "postIds": number[]}, ...]}`;

export function buildWeeklyPrompt(payload: WeeklyPayload): string {
  return [
    `Account: @${payload.account.handle}` +
      (payload.account.niche ? ` — niche: ${payload.account.niche}` : ''),
    `Week: ${payload.weekLabel} (Riyadh, Monday to Sunday).`,
    '',
    'YOUR WEEK — every number computed from the database:',
    JSON.stringify(payload.recap, null, 1),
    '',
    'YOUR NICHE — competitor breakouts and topic movement:',
    JSON.stringify(payload.trends, null, 1),
    '',
    payload.recap.notes.length > 0
      ? `Known gaps in the data this week, which you should respect rather than paper over:\n` +
        payload.recap.notes.map((n) => `- ${n}`).join('\n')
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
