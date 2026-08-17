import type { AggregateSnapshot } from './aggregate';
import type { Gap, GapAnalysis, Pattern } from '../prompts/gap-analysis.v1';

/**
 * Validate the model's claims against Layer A before anything is stored.
 *
 * This is the load-bearing part of the whole design. The model writes the
 * sentence; the arithmetic underneath it has to be ours. A claim whose evidence
 * is empty, whose post_ids don't exist, or whose percentages don't appear
 * anywhere in the aggregates is rejected — and a rejected analysis is retried
 * once with the failures spelled out.
 */

export interface ReconciliationIssue {
  where: string;
  problem: string;
}

export interface ReconciliationResult {
  ok: boolean;
  issues: ReconciliationIssue[];
  /** post_ids that were cited but do not exist in the corpus. */
  unknownEvidence: number[];
}

/** Every percentage-like token the aggregates actually contain. */
function knownNumbers(aggregate: string): Set<string> {
  const out = new Set<string>();
  for (const match of aggregate.matchAll(/\d+(?:\.\d+)?%?/g)) {
    out.add(match[0]);
    // "51%" should also satisfy a claim that says "51".
    if (match[0].endsWith('%')) out.add(match[0].slice(0, -1));
  }
  return out;
}

function statIsGrounded(stat: string, numbers: Set<string>): boolean {
  const tokens = [...stat.matchAll(/\d+(?:\.\d+)?%?/g)].map((m) => m[0]);
  // A stat with no number in it is a description, not a statistic — allowed,
  // because "more than half" style phrasing is checked by the number beside it.
  if (tokens.length === 0) return true;
  return tokens.some((token) => numbers.has(token) || numbers.has(token.replace('%', '')));
}

export function reconcile(
  analysis: GapAnalysis,
  snapshot: AggregateSnapshot,
  renderedAggregate: string,
): ReconciliationResult {
  const issues: ReconciliationIssue[] = [];
  const validPostIds = new Set<number>([
    ...snapshot.winners.map((w) => w.postId),
    ...snapshot.archetypes.map((a) => a.archetypeId),
  ]);
  const numbers = knownNumbers(renderedAggregate);
  const unknownEvidence: number[] = [];

  const checkOne = (item: Pattern | Gap, where: string): void => {
    if (item.evidence.length === 0) {
      issues.push({ where, problem: 'evidence is empty — a claim with no receipts is not usable' });
    }

    const unknown = item.evidence.filter((id) => !validPostIds.has(id));
    if (unknown.length > 0) {
      unknownEvidence.push(...unknown);
      issues.push({
        where,
        problem: `cites post_ids not present in the aggregates: ${unknown.join(', ')}`,
      });
    }

    if (!statIsGrounded(item.niche_stat, numbers)) {
      issues.push({ where, problem: `niche_stat "${item.niche_stat}" does not match any figure in the aggregates` });
    }
    if (!statIsGrounded(item.my_stat, numbers)) {
      issues.push({ where, problem: `my_stat "${item.my_stat}" does not match any figure in the aggregates` });
    }
  };

  analysis.patterns.forEach((pattern, index) => checkOne(pattern, `pattern ${index + 1}`));
  checkOne(analysis.gap, 'gap');

  if (analysis.patterns.length !== 5) {
    issues.push({ where: 'patterns', problem: `expected exactly 5, got ${analysis.patterns.length}` });
  }

  return { ok: issues.length === 0, issues, unknownEvidence: [...new Set(unknownEvidence)] };
}

/** Turned into a repair prompt when reconciliation fails the first time. */
export function describeIssues(issues: ReconciliationIssue[]): string {
  return issues.map((i) => `- ${i.where}: ${i.problem}`).join('\n');
}

/**
 * Drop evidence ids that don't exist rather than storing a claim that links
 * nowhere. Only used after a failed retry, when something is better than
 * nothing — and the UI shows that the analysis was repaired.
 */
export function pruneEvidence(analysis: GapAnalysis, snapshot: AggregateSnapshot): GapAnalysis {
  const valid = new Set(snapshot.winners.map((w) => w.postId));
  const prune = <T extends Pattern>(item: T): T => ({
    ...item,
    evidence: item.evidence.filter((id) => valid.has(id)),
  });
  return {
    patterns: analysis.patterns.map(prune),
    gap: prune(analysis.gap),
  };
}
