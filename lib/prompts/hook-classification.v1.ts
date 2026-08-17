import { z } from 'zod';

/**
 * A fixed taxonomy rather than free-form categories the model invents per
 * post — that's what makes "51% of top reels use X hook, you use it 20%"
 * possible at all. An open vocabulary would give every post its own
 * one-off label and nothing would aggregate.
 */
export const HOOK_CATEGORIES = [
  'question',
  'bold_claim',
  'curiosity_gap',
  'controversy',
  'personal_story',
  'how_to',
  'listicle',
  'before_after',
  'relatable_pain_point',
  'other',
] as const;

export const hookClassificationSchema = z.object({
  category: z.enum(HOOK_CATEGORIES),
  confidence: z.number().min(0).max(1),
});

export type HookClassification = z.infer<typeof hookClassificationSchema>;

export const HOOK_CLASSIFICATION_SYSTEM = `You classify the opening line of a social media post into exactly one
category. Categories:
- question: opens by asking the reader something
- bold_claim: a strong, confident assertion or promise
- curiosity_gap: teases information without revealing it ("the one thing nobody tells you about...")
- controversy: takes a contrarian or provocative stance
- personal_story: "I did X" / "here's what happened to me"
- how_to: a step-based or instructional promise
- listicle: "N mistakes" / "N ways" / numbered framing
- before_after: a transformation or comparison framing
- relatable_pain_point: names a shared frustration the reader recognizes
- other: doesn't clearly fit any of the above

Reply with ONLY a JSON object, no prose, no code fences:
{"category": one of the categories above, "confidence": number 0-1}`;

export function buildHookClassificationPrompt(input: {
  hookText: string;
  postType: string;
}): string {
  return `Post type: ${input.postType}\nOpening line: "${input.hookText || '(no caption)'}"`;
}
