import { mineBackCatalog, persistBackCatalog } from '../../analysis/back-catalog';
import { InsufficientData, runGapAnalysis } from '../../analysis/gap';
import { selfAccount } from '../../ingest/upsert';
import { enqueue } from '../queue';
import { JobPermanentError, JobYield, type JobContext } from '../types';

export async function runAnalysis(ctx: JobContext<'run_analysis'>): Promise<void> {
  const self = await selfAccount();
  if (!self) throw new JobPermanentError('no self account configured yet');

  await ctx.save({ progress: 0.2, label: 'computing patterns and gap' });

  let result;
  try {
    result = await runGapAnalysis(ctx.payload.windowDays);
  } catch (error) {
    if (error instanceof InsufficientData) {
      // Not a failure — there just isn't enough data yet (e.g. hook
      // classification hasn't finished). Retry later rather than erroring.
      throw new JobYield(error.message, 30);
    }
    throw error;
  }

  await ctx.save({ progress: 0.7, label: 'mining back catalogue' });
  const resurfaced = await mineBackCatalog(self.id);
  await persistBackCatalog(self.id, resurfaced);

  await ctx.save({
    progress: 1,
    label: `${result.patterns.length} patterns, gap: ${result.gap.name}`,
    checkpoint: { analysisId: result.id, resurfacedCount: resurfaced.length },
  });

  // Drafts need a voice profile; rebuilding it after every fresh analysis
  // keeps it current with whatever new captions have come in since the last one.
  await enqueue('build_voice_profile', { topN: 20 }, { dedupe: true });
}
