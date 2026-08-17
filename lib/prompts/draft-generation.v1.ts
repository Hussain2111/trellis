import { z } from 'zod';

/** Drafts are generated a few at a time rather than 12-in-one: smaller outputs fail schema validation far less often, and every retry costs quota. */

const carouselBody = z.object({
  kind: z.literal('carousel'),
  slides: z
    .array(z.object({ heading: z.string().max(80), body: z.string().max(300) }))
    .min(3)
    .max(10),
});

const reelBody = z.object({
  kind: z.literal('reel'),
  /** First two seconds, verbatim — this is the whole ballgame on a reel. */
  hook_line: z.string().max(140),
  beats: z
    .array(
      z.object({
        shot: z.string().max(200),
        on_screen_text: z.string().max(90),
        spoken: z.string().max(300),
      }),
    )
    .min(3)
    .max(8),
});

const imageBody = z.object({
  kind: z.literal('image'),
  concept: z.string().max(300),
  image_direction: z.string().max(400),
});

export const draftSchema = z.object({
  format: z.enum(['carousel', 'reel', 'image']),
  title: z.string().min(3).max(90),
  hook: z.string().min(3).max(160),
  body: z.discriminatedUnion('kind', [carouselBody, reelBody, imageBody]),
  caption: z.string().min(20).max(2200),
  hashtags: z.array(z.string().max(40)).max(15),
  cta: z.string().max(160),
  rationale: z.string().min(10).max(400),
  evidence: z.array(z.number().int()).max(10),
  pattern_index: z.number().int().min(0).max(4),
});

export const draftBatchSchema = z.object({ drafts: z.array(draftSchema).min(1).max(4) });

export type DraftOutput = z.infer<typeof draftSchema>;
export type DraftBatch = z.infer<typeof draftBatchSchema>;

export interface DraftPromptInput {
  voice: string;
  niche: string;
  gapClaim: string;
  patterns: { index: number; claim: string; nicheStat: string; myStat: string }[];
  formats: ('carousel' | 'reel' | 'image')[];
  avoidTitles: string[];
}

export const DRAFT_GENERATION_SYSTEM = `You write Instagram content in someone else's voice, aimed at closing one specific gap.

Rules:
- The VOICE block is binding. Match it. If it bans a word, the word does not appear.
- Every draft closes the stated gap. A draft that would be fine in general but does not address the gap is a failed draft.
- Each draft is tied to exactly one pattern (pattern_index) and carries a "rationale" saying which pattern it serves and why this execution.
- Carousels: a hook slide, then substance, then one CTA slide. Five slides is a good default, not a rule.
- Reels: hook_line is what is said or shown in the first two seconds, verbatim. Beats are shootable — "phone on a windowsill, hand enters frame", not "engaging visual".
- Captions read like the person, not like a brand. No "Are you struggling with...", no "Let's dive in".
- Hashtags: only ones that fit the niche. Fewer and specific beats many and generic.
- JSON only.`;

export function buildDraftGenerationPrompt(input: DraftPromptInput): string {
  return [
    input.voice,
    '',
    `NICHE: ${input.niche || 'unspecified'}`,
    '',
    `THE GAP TO CLOSE: ${input.gapClaim}`,
    '',
    'PATTERNS (use pattern_index to say which one a draft serves):',
    ...input.patterns.map(
      (p) => `  ${p.index}: ${p.claim} (niche ${p.nicheStat}, you ${p.myStat})`,
    ),
    '',
    input.avoidTitles.length
      ? `ALREADY DRAFTED — do not repeat these angles:\n${input.avoidTitles.map((t) => `  - ${t}`).join('\n')}\n`
      : '',
    `Write ${input.formats.length} drafts, in these formats, in order: ${input.formats.join(', ')}.`,
    '',
    'Return {"drafts":[{"format":"carousel|reel|image","title":"...","hook":"...","body":{...},"caption":"...","hashtags":[...],"cta":"...","rationale":"...","evidence":[post_id,...],"pattern_index":N}]}',
    '',
    'body shapes:',
    '  carousel: {"kind":"carousel","slides":[{"heading":"...","body":"..."}]}',
    '  reel:     {"kind":"reel","hook_line":"...","beats":[{"shot":"...","on_screen_text":"...","spoken":"..."}]}',
    '  image:    {"kind":"image","concept":"...","image_direction":"..."}',
  ]
    .filter(Boolean)
    .join('\n');
}
