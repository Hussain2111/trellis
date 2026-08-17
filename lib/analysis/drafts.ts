import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { analyses, drafts, posts } from '../db/schema';
import { complete } from '../providers/llm';
import {
  buildDraftGenerationPrompt,
  draftBatchSchema,
  DRAFT_GENERATION_SYSTEM,
  type DraftPromptInput,
} from '../prompts/draft-generation.v1';
import { voiceBlock } from './voice';
import { formatMix } from './format-mix';
import { selfAccount } from '../ingest/upsert';
import type { Gap, Pattern } from './patterns';

/** Drafts fail schema validation far less often in small batches — every retry costs quota. */
const BATCH_SIZE = 4;

export class NoAnalysis extends Error {}

/**
 * Generates `count` drafts for the given analysis, matched to the account's
 * voice and its own format mix, each tied to one of the analysis's 5
 * patterns (closing the gap the analysis identified).
 */
export async function generateDraftBatch(analysisId: number, count: number): Promise<number[]> {
  const [analysis] = await db().select().from(analyses).where(eq(analyses.id, analysisId)).limit(1);
  if (!analysis) throw new NoAnalysis(`analysis ${analysisId} not found`);

  const self = await selfAccount();
  if (!self) throw new Error('no self account configured');

  const patterns = analysis.patterns as (Pattern & { claim: string })[];
  const gap = analysis.gap as Gap;

  const [voiceText, selfPostRows, existingDraftRows, validPostIdRows] = await Promise.all([
    voiceBlock(),
    db().select({ type: posts.type }).from(posts).where(eq(posts.accountId, self.id)),
    db().select({ title: drafts.title }).from(drafts).where(eq(drafts.analysisId, analysisId)),
    db().select({ id: posts.id }).from(posts),
  ]);

  const formats = formatMix(
    selfPostRows.map((r) => r.type),
    count,
  );
  const validPostIds = new Set(validPostIdRows.map((r) => r.id));
  const avoidTitles = existingDraftRows.map((r) => r.title);

  const patternPromptInput = patterns.map((p, index) => ({
    index,
    claim: p.claim,
    nicheStat: `${Math.round(p.nicheStat * 100)}%`,
    myStat: `${Math.round(p.myStat * 100)}%`,
  }));

  const createdIds: number[] = [];

  for (let i = 0; i < formats.length; i += BATCH_SIZE) {
    const batchFormats = formats.slice(i, i + BATCH_SIZE);
    const input: DraftPromptInput = {
      voice: voiceText,
      niche: self.niche ?? '',
      gapClaim: gap.claim,
      patterns: patternPromptInput,
      formats: batchFormats,
      avoidTitles,
    };

    const result = await complete({
      operation: 'draft_generation',
      system: DRAFT_GENERATION_SYSTEM,
      prompt: buildDraftGenerationPrompt(input),
      schema: draftBatchSchema,
      temperature: 0.7,
    });

    for (const draft of result.value.drafts) {
      const patternIndex = Math.min(
        Math.max(draft.pattern_index, 0),
        Math.max(patterns.length - 1, 0),
      );
      // Never store evidence for a post that doesn't actually exist — the
      // model can hallucinate an id, the receipts trail can't.
      const evidence = draft.evidence.filter((id) => validPostIds.has(id));

      const [row] = await db()
        .insert(drafts)
        .values({
          analysisId,
          format: draft.format,
          patternIndex,
          title: draft.title,
          hook: draft.hook,
          body: draft.body,
          caption: draft.caption,
          hashtags: draft.hashtags,
          cta: draft.cta,
          rationale: draft.rationale,
          evidence,
          generatedBy: result.generatedBy,
        })
        .returning({ id: drafts.id });

      createdIds.push(row!.id);
      avoidTitles.push(draft.title);
    }
  }

  return createdIds;
}
