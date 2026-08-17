import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { accounts, postFeatures, posts, type Account, type Post } from '../db/schema';
import { median, percentile, share } from './stats';
import { engagementRate } from './features';

/**
 * Layer A benchmarking: me against the competitor pool, on numbers that are
 * comparable across accounts of different sizes.
 *
 * Every figure that leaves this file carries its sample size. A "51% vs your
 * 20%" claim built on nine posts is noise, and the UI has to be able to say so.
 */

export interface PostWithFeatures {
  post: Post;
  followers: number | null;
  handle: string;
  role: 'self' | 'competitor';
  engagementRate: number | null;
  hookText: string | null;
  hasCta: boolean;
  hasQuestion: boolean;
  hashtagCount: number;
  captionLength: number;
  postedHour: number | null;
  isOutlier: boolean;
}

export function loadCorpus(windowDays?: number): PostWithFeatures[] {
  const cutoff = windowDays ? Math.floor(Date.now() / 1000) - windowDays * 86400 : 0;

  return db()
    .select({
      post: posts,
      account: accounts,
      features: postFeatures,
    })
    .from(posts)
    .innerJoin(accounts, eq(accounts.id, posts.accountId))
    .leftJoin(postFeatures, eq(postFeatures.postId, posts.id))
    .all()
    .filter((row) => !cutoff || (row.post.takenAt ?? 0) >= cutoff)
    .map((row) => ({
      post: row.post,
      followers: row.account.followers,
      handle: row.account.handle,
      role: row.account.role,
      engagementRate:
        row.features?.engagementRate ?? engagementRate(row.post, row.account.followers),
      hookText: row.features?.hookText ?? null,
      hasCta: row.features?.hasCta ?? false,
      hasQuestion: row.features?.hasQuestion ?? false,
      hashtagCount: row.features?.hashtagCount ?? 0,
      captionLength: row.features?.captionLength ?? 0,
      postedHour: row.features?.postedHour ?? null,
      isOutlier: row.features?.isOutlier ?? false,
    }));
}

export interface FormatBenchmark {
  type: string;
  mine: { n: number; medianEngagementRate: number; medianLikes: number; share: number };
  niche: { n: number; medianEngagementRate: number; medianLikes: number; share: number };
  /** Positive means the niche does more of this than I do. */
  shareDelta: number;
}

export function benchmarkByFormat(corpus: PostWithFeatures[]): FormatBenchmark[] {
  const mine = corpus.filter((r) => r.role === 'self');
  const niche = corpus.filter((r) => r.role === 'competitor');
  const types = [...new Set(corpus.map((r) => r.post.type))];

  return types
    .map((type) => {
      const m = mine.filter((r) => r.post.type === type);
      const n = niche.filter((r) => r.post.type === type);
      const mineShare = share(m.length, mine.length);
      const nicheShare = share(n.length, niche.length);
      return {
        type,
        mine: {
          n: m.length,
          medianEngagementRate: median(m.map((r) => r.engagementRate ?? 0).filter((v) => v > 0)),
          medianLikes: median(m.map((r) => r.post.likes ?? 0)),
          share: mineShare,
        },
        niche: {
          n: n.length,
          medianEngagementRate: median(n.map((r) => r.engagementRate ?? 0).filter((v) => v > 0)),
          medianLikes: median(n.map((r) => r.post.likes ?? 0)),
          share: nicheShare,
        },
        shareDelta: nicheShare - mineShare,
      };
    })
    .sort((a, b) => b.niche.n - a.niche.n);
}

export interface TraitBenchmark {
  trait: string;
  label: string;
  mine: { n: number; total: number; share: number };
  niche: { n: number; total: number; share: number };
  delta: number;
}

/**
 * Binary caption traits, mine vs the pool. These are the "51% of viral reels
 * open with X, you: 20%" claims — computed, not asserted.
 */
export function benchmarkTraits(corpus: PostWithFeatures[], topOnly = true): TraitBenchmark[] {
  const mine = corpus.filter((r) => r.role === 'self');
  // The comparison that matters is against what *wins* in the niche, not
  // against everything the niche posts.
  const nichePool = corpus.filter((r) => r.role === 'competitor');
  const threshold = percentile(
    nichePool.map((r) => r.engagementRate ?? 0),
    0.75,
  );
  const niche = topOnly
    ? nichePool.filter((r) => (r.engagementRate ?? 0) >= threshold)
    : nichePool;

  const traits: { trait: string; label: string; test: (r: PostWithFeatures) => boolean }[] = [
    { trait: 'has_cta', label: 'ends on a call to action', test: (r) => r.hasCta },
    { trait: 'has_question', label: 'opens with a question', test: (r) => r.hasQuestion },
    { trait: 'short_caption', label: 'caption under 200 characters', test: (r) => r.captionLength > 0 && r.captionLength < 200 },
    { trait: 'long_caption', label: 'caption over 800 characters', test: (r) => r.captionLength > 800 },
    { trait: 'few_hashtags', label: 'three hashtags or fewer', test: (r) => r.hashtagCount <= 3 },
    { trait: 'many_hashtags', label: 'ten hashtags or more', test: (r) => r.hashtagCount >= 10 },
  ];

  return traits
    .map((t) => {
      const mineHits = mine.filter(t.test).length;
      const nicheHits = niche.filter(t.test).length;
      const mineShare = share(mineHits, mine.length);
      const nicheShare = share(nicheHits, niche.length);
      return {
        trait: t.trait,
        label: t.label,
        mine: { n: mineHits, total: mine.length, share: mineShare },
        niche: { n: nicheHits, total: niche.length, share: nicheShare },
        delta: nicheShare - mineShare,
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

export interface PoolComposition {
  accounts: { handle: string; followers: number | null; posts: number }[];
  totalPosts: number;
  medianFollowers: number;
  /** Under ~5 accounts, confident nonsense is the likely outcome. */
  thin: boolean;
  warning: string | null;
}

/**
 * The benchmark is only as good as the competitor list, so its composition is
 * shown wherever a benchmark appears rather than buried in settings.
 */
export function poolComposition(corpus: PostWithFeatures[]): PoolComposition {
  const niche = corpus.filter((r) => r.role === 'competitor');
  const byHandle = new Map<string, { handle: string; followers: number | null; posts: number }>();

  for (const row of niche) {
    const entry = byHandle.get(row.handle) ?? {
      handle: row.handle,
      followers: row.followers,
      posts: 0,
    };
    entry.posts++;
    byHandle.set(row.handle, entry);
  }

  const list = [...byHandle.values()].sort((a, b) => b.posts - a.posts);
  const thin = list.length < 5 || niche.length < 100;

  return {
    accounts: list,
    totalPosts: niche.length,
    medianFollowers: median(list.map((a) => a.followers ?? 0).filter((v) => v > 0)),
    thin,
    warning: thin
      ? `Benchmarked against ${list.length} account(s) and ${niche.length} posts. ` +
        `That is thin — treat these numbers as directional until the list is broader.`
      : null,
  };
}

export interface WinnersSummary {
  winners: PostWithFeatures[];
  myMedianLikes: number;
  threshold: number;
}

/** My own outliers — the back catalogue worth mining. */
export function myWinners(corpus: PostWithFeatures[], multiplier: number): WinnersSummary {
  const mine = corpus.filter((r) => r.role === 'self');
  const myMedianLikes = median(mine.map((r) => r.post.likes ?? 0));
  return {
    winners: mine
      .filter((r) => r.isOutlier)
      .sort((a, b) => (b.post.likes ?? 0) - (a.post.likes ?? 0)),
    myMedianLikes,
    threshold: myMedianLikes * multiplier,
  };
}

export function competitorAccounts(): Account[] {
  return db().select().from(accounts).where(eq(accounts.role, 'competitor')).all();
}

export function topPosts(accountId: number, limit: number): Post[] {
  return db()
    .select()
    .from(posts)
    .where(eq(posts.accountId, accountId))
    .orderBy(desc(posts.likes))
    .limit(limit)
    .all();
}

export function postsByIds(ids: number[]): Post[] {
  if (ids.length === 0) return [];
  return db().select().from(posts).where(inArray(posts.id, ids)).all();
}
