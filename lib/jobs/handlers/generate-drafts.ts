import { generateDraftBatch } from '../../analysis/drafts';
import { JobPermanentError, type JobContext } from '../types';

/** 12 drafts/week, matched to voice and format mix, each closing the analysis's gap — the spec's draft-generation deliverable. */
export async function generateDrafts(ctx: JobContext<'generate_drafts'>): Promise<void> {
  try {
    const ids = await generateDraftBatch(ctx.payload.analysisId, ctx.payload.count);
    await ctx.save({
      progress: 1,
      label: `${ids.length} draft(s) generated`,
      checkpoint: { draftIds: ids },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'NoAnalysis') {
      throw new JobPermanentError(error.message);
    }
    throw error;
  }
}
