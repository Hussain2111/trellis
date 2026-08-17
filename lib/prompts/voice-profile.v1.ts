import { z } from 'zod';

/**
 * The voice profile rides along in every generation prompt, so it is kept
 * deliberately short — prompt size is what burns quota, and a 2,000-word
 * style essay would cost more than it buys on every single draft.
 */

export const voiceFieldsSchema = z.object({
  tone: z.string().max(160),
  sentence_rhythm: z.string().max(160),
  vocabulary: z.array(z.string().max(40)).max(12),
  recurring_phrases: z.array(z.string().max(60)).max(8),
  banned_words: z.array(z.string().max(30)).max(12),
  cta_style: z.string().max(160),
  emoji_policy: z.string().max(120),
  formatting_habits: z.string().max(200),
  recurring_subjects: z.array(z.string().max(40)).max(10),
});

export const voiceProfileSchema = z.object({
  markdown: z.string().min(50).max(2400),
  fields: voiceFieldsSchema,
});

export type VoiceFields = z.infer<typeof voiceFieldsSchema>;
export type VoiceProfileOutput = z.infer<typeof voiceProfileSchema>;

export const VOICE_PROFILE_SYSTEM = `You reverse-engineer a creator's writing voice from their own captions.

You are describing how THIS person writes, not how a good caption should be written. If they overuse a word, that is part of the voice. If they never use emoji, say so.

Rules:
- Evidence only. Every observation must be visible in the captions given.
- Be concrete. "Short declaratives, often starting with a verb" beats "engaging and punchy".
- banned_words = words this person demonstrably avoids or that would sound wrong in their voice. Include the generic-marketer vocabulary they never use.
- The markdown is a brief the writer reads before drafting: at most 250 words, no headings deeper than one level.
- JSON only.`;

export interface VoiceProfileInput {
  handle: string;
  niche: string | null;
  captions: string[];
}

export function buildVoiceProfilePrompt(input: VoiceProfileInput): string {
  return [
    `Creator: @${input.handle}${input.niche ? ` — ${input.niche}` : ''}`,
    '',
    `Their ${input.captions.length} best-performing captions:`,
    '',
    ...input.captions.map((c, i) => `--- ${i + 1} ---\n${c.slice(0, 900)}`),
    '',
    'Return {"markdown":"...","fields":{"tone":"...","sentence_rhythm":"...","vocabulary":[...],"recurring_phrases":[...],"banned_words":[...],"cta_style":"...","emoji_policy":"...","formatting_habits":"...","recurring_subjects":[...]}}',
  ].join('\n');
}

/** Compact form injected into every generation prompt. Kept under ~150 tokens. */
export function renderVoiceForPrompt(fields: VoiceFields): string {
  return [
    `VOICE — write as this person, not about them:`,
    `tone: ${fields.tone}`,
    `rhythm: ${fields.sentence_rhythm}`,
    fields.recurring_phrases.length ? `uses: ${fields.recurring_phrases.join(' / ')}` : '',
    fields.banned_words.length ? `never: ${fields.banned_words.join(', ')}` : '',
    `CTA: ${fields.cta_style}`,
    `emoji: ${fields.emoji_policy}`,
    `formatting: ${fields.formatting_habits}`,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 900);
}
