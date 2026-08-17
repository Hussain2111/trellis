import { predicateForKey, type EnrichedPost, type Pattern } from './patterns';
import { share } from './stats';

export interface ReconcileIssue {
  patternKey: string;
  reason: string;
}

/**
 * The evidence-reconciliation check the spec requires before this stage
 * counts as done: every stat's claimed post_ids must actually support the
 * claim. Three independent checks per pattern, any of which failing means
 * the "receipts" can't be trusted:
 *
 * 1. Every listed post id exists in the corpus.
 * 2. Every listed post id actually satisfies the predicate the pattern's
 *    `key` implies (re-derived from `predicateForKey`, not trusted from
 *    whatever built the pattern).
 * 3. The stat recomputed from `postIds.length / sampleSize` matches the
 *    stored stat, within floating-point tolerance.
 */
export function reconcilePatterns(patterns: Pattern[], corpus: EnrichedPost[]): ReconcileIssue[] {
  const byId = new Map(corpus.map((p) => [p.id, p]));
  const issues: ReconcileIssue[] = [];

  for (const pattern of patterns) {
    let predicate: (post: EnrichedPost) => boolean;
    try {
      predicate = predicateForKey(pattern.key);
    } catch (error) {
      issues.push({ patternKey: pattern.key, reason: (error as Error).message });
      continue;
    }

    for (const [side, ids, sampleSize, stat] of [
      ['niche', pattern.nichePostIds, pattern.nicheSampleSize, pattern.nicheStat],
      ['my', pattern.myPostIds, pattern.mySampleSize, pattern.myStat],
    ] as const) {
      for (const id of ids) {
        const post = byId.get(id);
        if (!post) {
          issues.push({
            patternKey: pattern.key,
            reason: `${side} post id ${id} is not in the corpus`,
          });
          continue;
        }
        if (!predicate(post)) {
          issues.push({
            patternKey: pattern.key,
            reason: `${side} post id ${id} does not satisfy "${pattern.key}"`,
          });
        }
      }

      const recomputed = share(ids.length, sampleSize);
      if (Math.abs(recomputed - stat) > 1e-9) {
        issues.push({
          patternKey: pattern.key,
          reason: `${side}Stat is ${stat} but ${ids.length}/${sampleSize} recomputes to ${recomputed}`,
        });
      }
    }
  }

  return issues;
}
