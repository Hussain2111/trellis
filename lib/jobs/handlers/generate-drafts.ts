import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { drafts } from '../../db/schema';
import { generateDraftBatch } from '../../analysis/drafts';
import { enqueue } from '../queue';
import { JobPermanentError, type JobContext } from '../types';

/** 12 drafts/week, matched to voice and format mix, each closing the analysis's gap — the spec's draft-generation deliverable. */
export async function generateDrafts(ctx: JobContext<'generate_drafts'>): Promise<void> {
  let ids: number[];
  try {
    ids = await generateDraftBatch(ctx.payload.analysisId, ctx.payload.count);
  } catch (error) {
    if (error instanceof Error && error.name === 'NoAnalysis') {
      throw new JobPermanentError(error.message);
    }
    throw error;
  }

  await ctx.save({
    progress: 1,
    label: `${ids.length} draft(s) generated`,
    checkpoint: { draftIds: ids },
  });

  // Only carousels have anything to render; render_slides no-ops cleanly for the rest.
  const carousels = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(eq(drafts.format, 'carousel'));
  const carouselIds = new Set(carousels.map((d) => d.id));
  for (const id of ids) {
    if (carouselIds.has(id)) await enqueue('render_slides', { draftId: id }, { priority: 5 });
  }
}
