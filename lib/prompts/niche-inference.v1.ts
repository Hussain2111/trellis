import { z } from 'zod';

export const nicheInferenceSchema = z.object({
  niche: z.string().min(3).max(60),
  description: z.string().min(20).max(300),
});

export type NicheInference = z.infer<typeof nicheInferenceSchema>;

export interface NicheInferenceInput {
  handle: string;
  bio: string | null;
  captions: string[];
  hashtags: string[];
}

const SYSTEM = `You are a social media strategist. Given an Instagram account's bio, recent
captions, and most-used hashtags, name its content niche in a few words (e.g.
"personal finance for freelancers", "home renovation DIY", "boutique fitness
coaching") and write one sentence describing who the content is for and what
it promises them. Reply with ONLY a JSON object matching this shape, no prose,
no code fences:
{"niche": string, "description": string}`;

export function buildNicheInferencePrompt(input: NicheInferenceInput): string {
  const captionBlock = input.captions
    .slice(0, 15)
    .map((c, i) => `${i + 1}. ${c.slice(0, 240).replace(/\n+/g, ' ')}`)
    .join('\n');

  return [
    `Handle: @${input.handle}`,
    `Bio: ${input.bio ?? '(none)'}`,
    `Most-used hashtags: ${input.hashtags.length ? input.hashtags.map((h) => `#${h}`).join(', ') : '(none)'}`,
    '',
    'Recent captions:',
    captionBlock || '(none)',
  ].join('\n');
}

export { SYSTEM as NICHE_INFERENCE_SYSTEM };
