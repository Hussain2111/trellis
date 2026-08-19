import { mineBackCatalog, persistBackCatalog } from '../../analysis/back-catalog';
import { InsufficientData, runPatternAnalysis } from '../../analysis/analysis';
import { selfAccount } from '../../ingest/upsert';
import { JobPermanentError, JobYield, type JobContext } from '../types';

export async function runAnalysis(ctx: JobContext<'run_analysis'>): Promise<void> {
  const self = await selfAccount();
  if (!self) throw new JobPermanentError('no self account configured yet');

  await ctx.save({ progress: 0.2, label: 'computing patterns' });

  let result;
  try {
    result = await runPatternAnalysis(ctx.payload.windowDays);
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
    label: `${result.patterns.length} patterns`,
    checkpoint: { analysisId: result.id, resurfacedCount: resurfaced.length },
  });
}
