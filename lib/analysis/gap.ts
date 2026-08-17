import { createHash } from 'node:crypto';
import { biggestGap, computePatterns, type Gap, type Pattern } from './patterns';
import { loadCorpus } from './corpus';
import { reconcilePatterns } from './reconcile';
import { complete } from '../providers/llm';
import {
  buildGapAnalysisPrompt,
  gapAnalysisSchema,
  GAP_ANALYSIS_SYSTEM,
} from '../prompts/gap-analysis.v1';
import { db } from '../db/client';
import { analyses } from '../db/schema';

/** Never trusts model prose with the actual numbers — the receipts never depend on the model doing arithmetic correctly. */
function deterministicClaim(pattern: Pattern): string {
  return (
    `${(pattern.nicheStat * 100).toFixed(0)}% of top performers in your niche use ${pattern.name}, ` +
    `you do it ${(pattern.myStat * 100).toFixed(0)}% of the time ` +
    `(niche n=${pattern.nicheSampleSize}, you n=${pattern.mySampleSize}).`
  );
}

/** A claim is trusted only if it mentions both rounded percentages it's supposed to be about. */
function claimMentionsBothStats(claim: string, pattern: Pattern): boolean {
  const mentioned = new Set([...claim.matchAll(/(\d+)%/g)].map((m) => Number(m[1])));
  const nichePct = Math.round(pattern.nicheStat * 100);
  const myPct = Math.round(pattern.myStat * 100);
  const near = (target: number) => [...mentioned].some((n) => Math.abs(n - target) <= 1);
  return near(nichePct) && near(myPct);
}

async function phraseClaims(
  patterns: Pattern[],
): Promise<{ claims: Map<string, string>; generatedBy: string }> {
  const claims = new Map<string, string>();
  let generatedBy = 'deterministic';

  try {
    const result = await complete({
      operation: 'gap_analysis',
      system: GAP_ANALYSIS_SYSTEM,
      prompt: buildGapAnalysisPrompt(patterns),
      schema: gapAnalysisSchema,
      temperature: 0.4,
    });
    generatedBy = result.generatedBy;
    for (const { key, claim } of result.value.claims) {
      const pattern = patterns.find((p) => p.key === key);
      if (pattern && claimMentionsBothStats(claim, pattern)) claims.set(key, claim);
    }
  } catch {
    // Model unavailable, quota spent, or every claim failed validation — the
    // deterministic fallback below covers every pattern regardless.
  }

  for (const pattern of patterns) {
    if (!claims.has(pattern.key)) claims.set(pattern.key, deterministicClaim(pattern));
  }

  return { claims, generatedBy };
}

function hashCorpus(corpus: { id: number }[]): string {
  const ids = corpus
    .map((p) => p.id)
    .sort((a, b) => a - b)
    .join(',');
  return createHash('sha256').update(ids).digest('hex').slice(0, 16);
}

export interface AnalysisResult {
  id: number;
  patterns: (Pattern & { claim: string })[];
  gap: Gap;
  generatedBy: string;
}

export class InsufficientData extends Error {}

/**
 * The full Layer A → C pipeline: load the corpus, compute the 5 patterns
 * and the single biggest gap deterministically, reconcile every claimed
 * post id against the corpus, then phrase each pattern as a sentence
 * (Gemini, with a validated deterministic fallback), and persist.
 */
export async function runGapAnalysis(windowDays: number): Promise<AnalysisResult> {
  const corpus = await loadCorpus();
  const patterns = computePatterns(corpus);
  if (patterns.length === 0) {
    throw new InsufficientData(
      'Not enough data yet — need both self and competitor posts with computed features.',
    );
  }

  const issues = reconcilePatterns(patterns, corpus);
  if (issues.length > 0) {
    throw new Error(
      `Evidence reconciliation failed: ${issues.map((i) => `${i.patternKey}: ${i.reason}`).join('; ')}`,
    );
  }

  const gapPattern = biggestGap(patterns);
  if (!gapPattern) throw new InsufficientData('No pattern qualified as the biggest gap.');

  const { claims, generatedBy } = await phraseClaims(patterns);

  const patternsWithClaims = patterns.map((p) => ({ ...p, claim: claims.get(p.key)! }));
  const gap: Gap = { ...gapPattern, claim: claims.get(gapPattern.key)! };

  const [row] = await db()
    .insert(analyses)
    .values({
      windowDays,
      patterns: patternsWithClaims,
      gap,
      inputsHash: hashCorpus(corpus),
      generatedBy,
    })
    .returning({ id: analyses.id });

  return { id: row!.id, patterns: patternsWithClaims, gap, generatedBy };
}
