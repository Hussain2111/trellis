import { generateOpportunities, generateWeekly } from '../../generate/run';
import type { JobContext } from '../types';

/**
 * Runs the interpretation pass. Enqueued by the weekly cron, never by a page.
 *
 * Each kind is generated independently and a failure in one does not abort the
 * other: a failed Opportunities generation should not cost you the weekly
 * read as well. Both fall back to their deterministic output on failure, which
 * the page labels as unelaborated.
 */
export async function generateInsights(ctx: JobContext<'generate_insights'>): Promise<void> {
  const summaries: string[] = [];

  for (const [i, kind] of ctx.payload.kinds.entries()) {
    await ctx.save({
      progress: i / ctx.payload.kinds.length,
      label: `generating ${kind}`,
    });

    const outcome =
      kind === 'opportunities' ? await generateOpportunities() : await generateWeekly();

    summaries.push(
      `${kind}: ${outcome.status}` +
        (outcome.kept > 0 ? `, ${outcome.kept} kept` : '') +
        (outcome.dropped > 0 ? `, ${outcome.dropped} dropped in validation` : ''),
    );
  }

  await ctx.save({ progress: 1, label: summaries.join(' · '), checkpoint: { summaries } });
}
