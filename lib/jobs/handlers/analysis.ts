import { desc, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { analyses } from '../../db/schema';
import { buildAggregate, renderAggregate } from '../../analysis/aggregate';
import { describeIssues, pruneEvidence, reconcile } from '../../analysis/reconcile';
import { gapAnalysis, type GapAnalysis } from '../../prompts/gap-analysis.v1';
import { complete } from '../../providers/llm';
import { selfAccount } from '../../ingest/upsert';
import { getSettings } from '../../settings';
import { JobPermanentError, type JobContext } from '../types';

/**
 * One Tier A call over the aggregates, then reconciliation. If the claims don't
 * check out against Layer A, retry once with the specific failures named — and
 * if the retry still fails, store the repaired version and flag it rather than
 * silently presenting numbers that don't reconcile.
 */
export async function runAnalysis(ctx: JobContext<'run_analysis'>): Promise<void> {
  const settings = getSettings();
  const self = selfAccount();
  if (!self) throw new JobPermanentError('No account marked as yours. Add one in Settings first.');

  ctx.save({ progress: 0.1, label: 'building aggregates' });

  const snapshot = buildAggregate({
    windowDays: ctx.payload.windowDays,
    niche: settings.niche,
    handle: self.handle,
    outlierMultiplier: settings.outlierMultiplier,
  });

  if (snapshot.counts.niche === 0) {
    throw new JobPermanentError(
      'No competitor posts to benchmark against. Add competitors and scan them first.',
    );
  }

  const rendered = renderAggregate(snapshot);
  ctx.save({ progress: 0.3, label: `analysing ${snapshot.counts.mine + snapshot.counts.niche} posts` });

  const ask = async (extra?: string): Promise<{ value: GapAnalysis; generatedBy: string; degraded: boolean }> => {
    const result = await complete({
      tier: 'A',
      operation: 'gap_analysis',
      system: gapAnalysis.system,
      prompt: gapAnalysis.render({ aggregate: rendered, windowDays: ctx.payload.windowDays }) +
        (extra ? `\n\n--- Your previous attempt failed validation:\n${extra}\n\nFix these and return the corrected JSON.` : ''),
      schema: gapAnalysis.schema!,
      maxOutputTokens: 3072,
      temperature: 0.3,
    });
    return { value: result.value, generatedBy: result.generatedBy, degraded: result.degraded };
  };

  let attempt = await ask();
  let check = reconcile(attempt.value, snapshot, rendered);
  let repaired = false;

  if (!check.ok) {
    ctx.save({ progress: 0.6, label: `claims did not reconcile (${check.issues.length}) — retrying once` });
    attempt = await ask(describeIssues(check.issues));
    check = reconcile(attempt.value, snapshot, rendered);

    if (!check.ok) {
      // Second failure: keep what reconciles, drop what doesn't, and record it.
      attempt = { ...attempt, value: pruneEvidence(attempt.value, snapshot) };
      repaired = true;
    }
  }

  db()
    .insert(analyses)
    .values({
      windowDays: ctx.payload.windowDays,
      patterns: attempt.value.patterns,
      gap: { ...attempt.value.gap, repaired, issues: repaired ? check.issues : [] },
      inputsHash: snapshot.inputsHash,
      generatedBy: `${attempt.generatedBy}${attempt.degraded ? ' (degraded)' : ''}${repaired ? ' (repaired)' : ''}`,
    })
    .run();

  ctx.save({
    progress: 1,
    label: repaired
      ? '5 patterns + 1 gap, some evidence pruned'
      : '5 patterns + 1 gap, all claims reconciled',
  });
}

export function latestAnalysis() {
  return db().select().from(analyses).orderBy(desc(analyses.id)).limit(1).get() ?? null;
}

export function analysisById(id: number) {
  return db().select().from(analyses).where(eq(analyses.id, id)).get() ?? null;
}
