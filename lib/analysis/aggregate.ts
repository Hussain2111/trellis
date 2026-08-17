import { createHash } from 'node:crypto';
import { archetypeCrossTab, labelsForPosts, type ArchetypeCrossTab } from './archetypes';
import {
  benchmarkByFormat,
  benchmarkTraits,
  loadCorpus,
  myWinners,
  poolComposition,
  type FormatBenchmark,
  type PoolComposition,
  type TraitBenchmark,
} from './benchmark';
import { cadenceByWeek } from './features';

/**
 * The compact table that goes to Tier A. A few hundred lines, never the corpus.
 *
 * This is the thing that makes gap analysis affordable: the model gets
 * aggregates it can reason over, not 1,100 captions it would have to read.
 */

export interface DecayedArchetype {
  archetypeId: number;
  name: string;
  /** How many of my winners used this archetype. */
  winnerCount: number;
  /** How many times I've used it in the recent window. */
  recentCount: number;
  lastUsedDaysAgo: number | null;
  medianLikesWhenUsed: number;
}

/**
 * Back-catalogue mining: archetypes present among my winners but near-absent
 * lately. Pure arithmetic — no model goes anywhere near this.
 */
export function detectDecay(windowDays: number, multiplier: number): DecayedArchetype[] {
  const corpus = loadCorpus();
  const { winners } = myWinners(corpus, multiplier);
  const crossTab = archetypeCrossTab();
  const nowS = Math.floor(Date.now() / 1000);
  const cutoff = nowS - windowDays * 86400;

  const winnerIds = new Set(winners.map((w) => w.post.id));
  const winnerLabels = labelsForPosts([...winnerIds]);

  const winnerCountByArchetype = new Map<number, number>();
  for (const label of winnerLabels) {
    winnerCountByArchetype.set(
      label.archetypeId,
      (winnerCountByArchetype.get(label.archetypeId) ?? 0) + 1,
    );
  }

  const mineRecent = corpus.filter((r) => r.role === 'self' && (r.post.takenAt ?? 0) >= cutoff);
  const recentLabels = labelsForPosts(mineRecent.map((r) => r.post.id));
  const recentCountByArchetype = new Map<number, number>();
  for (const label of recentLabels) {
    recentCountByArchetype.set(
      label.archetypeId,
      (recentCountByArchetype.get(label.archetypeId) ?? 0) + 1,
    );
  }

  const winnerLikes = new Map<number, number[]>();
  const likesByPost = new Map(corpus.map((r) => [r.post.id, r.post.likes ?? 0] as const));
  for (const label of winnerLabels) {
    const list = winnerLikes.get(label.archetypeId) ?? [];
    list.push(likesByPost.get(label.postId) ?? 0);
    winnerLikes.set(label.archetypeId, list);
  }

  return crossTab
    .map((row): DecayedArchetype => {
      const likes = (winnerLikes.get(row.archetypeId) ?? []).sort((a, b) => a - b);
      return {
        archetypeId: row.archetypeId,
        name: row.name,
        winnerCount: winnerCountByArchetype.get(row.archetypeId) ?? 0,
        recentCount: recentCountByArchetype.get(row.archetypeId) ?? 0,
        lastUsedDaysAgo: row.lastUsedByMe
          ? Math.floor((nowS - row.lastUsedByMe) / 86400)
          : null,
        medianLikesWhenUsed: likes.length ? likes[Math.floor(likes.length / 2)]! : 0,
      };
    })
    .filter((row) => row.winnerCount > 0 && row.recentCount === 0)
    .sort((a, b) => b.medianLikesWhenUsed - a.medianLikesWhenUsed);
}

export interface AggregateSnapshot {
  windowDays: number;
  niche: string;
  handle: string;
  myFollowers: number | null;
  counts: { mine: number; niche: number };
  formats: FormatBenchmark[];
  traits: TraitBenchmark[];
  archetypes: ArchetypeCrossTab[];
  decayed: DecayedArchetype[];
  winners: { postId: number; shortcode: string; likes: number; type: string; hook: string }[];
  cadence: { weekStart: number; total: number; byType: Record<string, number> }[];
  pool: PoolComposition;
  inputsHash: string;
}

export function buildAggregate(options: {
  windowDays: number;
  niche: string;
  handle: string;
  outlierMultiplier: number;
}): AggregateSnapshot {
  const corpus = loadCorpus();
  const mine = corpus.filter((r) => r.role === 'self');
  const { winners } = myWinners(corpus, options.outlierMultiplier);

  const snapshot: Omit<AggregateSnapshot, 'inputsHash'> = {
    windowDays: options.windowDays,
    niche: options.niche,
    handle: options.handle,
    myFollowers: mine[0]?.followers ?? null,
    counts: { mine: mine.length, niche: corpus.length - mine.length },
    formats: benchmarkByFormat(corpus),
    traits: benchmarkTraits(corpus),
    archetypes: archetypeCrossTab(),
    decayed: detectDecay(options.windowDays, options.outlierMultiplier),
    winners: winners.slice(0, 15).map((w) => ({
      postId: w.post.id,
      shortcode: w.post.shortcode,
      likes: w.post.likes ?? 0,
      type: w.post.type,
      hook: (w.hookText ?? '').slice(0, 100),
    })),
    cadence: cadenceByWeek(mine.map((r) => r.post)),
    pool: poolComposition(corpus),
  };

  return {
    ...snapshot,
    inputsHash: createHash('sha256')
      .update(
        JSON.stringify({
          counts: snapshot.counts,
          formats: snapshot.formats,
          traits: snapshot.traits,
          archetypes: snapshot.archetypes.map((a) => [a.archetypeId, a.mine, a.niche]),
        }),
      )
      .digest('hex')
      .slice(0, 16),
  };
}

/** Render the snapshot as the compact table the prompt actually sends. */
export function renderAggregate(snapshot: AggregateSnapshot): string {
  const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
  const lines: string[] = [];

  lines.push(`ME: @${snapshot.handle} · ${snapshot.myFollowers ?? '?'} followers · ${snapshot.counts.mine} posts`);
  lines.push(`NICHE POOL: ${snapshot.pool.accounts.length} accounts · ${snapshot.counts.niche} posts`);
  lines.push(`NICHE: ${snapshot.niche || 'unspecified'}`);
  if (snapshot.pool.warning) lines.push(`CAVEAT: ${snapshot.pool.warning}`);
  lines.push('');

  lines.push('FORMAT MIX (share of posts, median engagement rate):');
  for (const f of snapshot.formats) {
    lines.push(
      `  ${f.type}: me ${pct(f.mine.share)} (n=${f.mine.n}, er ${(f.mine.medianEngagementRate * 100).toFixed(2)}%) | ` +
        `niche ${pct(f.niche.share)} (n=${f.niche.n}, er ${(f.niche.medianEngagementRate * 100).toFixed(2)}%)`,
    );
  }
  lines.push('');

  lines.push('CAPTION TRAITS (share, niche column is top-quartile posts only):');
  for (const t of snapshot.traits) {
    lines.push(
      `  ${t.trait} "${t.label}": me ${pct(t.mine.share)} (${t.mine.n}/${t.mine.total}) | ` +
        `niche ${pct(t.niche.share)} (${t.niche.n}/${t.niche.total}) | delta ${pct(t.delta)}`,
    );
  }
  lines.push('');

  lines.push('ARCHETYPE CROSS-TAB (share of each side\'s posts):');
  for (const a of snapshot.archetypes.slice(0, 20)) {
    lines.push(
      `  [${a.archetypeId}] ${a.name}: me ${pct(a.mineShare)} (${a.mine}) | niche ${pct(a.nicheShare)} (${a.niche}) | ` +
        `delta ${pct(a.delta)} | median er ${(a.medianEngagementRate * 100).toFixed(2)}%`,
    );
  }
  lines.push('');

  if (snapshot.decayed.length) {
    lines.push(`DECAYED (worked before, absent in the last ${snapshot.windowDays} days):`);
    for (const d of snapshot.decayed.slice(0, 8)) {
      lines.push(
        `  [${d.archetypeId}] ${d.name}: ${d.winnerCount} of my winners, median ${d.medianLikesWhenUsed} likes, ` +
          `last used ${d.lastUsedDaysAgo ?? '?'} days ago, 0 in the window`,
      );
    }
    lines.push('');
  }

  lines.push('MY WINNERS (post_id, likes, type, hook):');
  for (const w of snapshot.winners) {
    lines.push(`  ${w.postId} | ${w.likes} | ${w.type} | ${w.hook}`);
  }
  lines.push('');

  const recentWeeks = snapshot.cadence.slice(-6);
  lines.push('MY CADENCE (last 6 weeks, posts/week):');
  lines.push(`  ${recentWeeks.map((w) => w.total).join(', ')}`);

  return lines.join('\n');
}
