import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, sqlite } from '../db/client';
import { archetypes, postEmbeddings, postFeatures, postLabels, posts } from '../db/schema';
import { assignToNearest, chooseK, driftFraction, representatives } from './cluster';
import { cosineSimilarity, fromBlob, toBlob } from './vector';

const nowS = (): number => Math.floor(Date.now() / 1000);

export interface StoredEmbedding {
  postId: number;
  vector: Float32Array;
}

export function loadEmbeddings(model?: string): StoredEmbedding[] {
  const rows = model
    ? db().select().from(postEmbeddings).where(eq(postEmbeddings.model, model)).all()
    : db().select().from(postEmbeddings).all();
  return rows.map((row) => ({
    postId: row.postId,
    vector: fromBlob(row.vector as Buffer, row.dim),
  }));
}

export function saveEmbedding(
  postId: number,
  vector: Float32Array,
  model: string,
  sourceText: string,
): void {
  const values = {
    postId,
    vector: toBlob(vector),
    dim: vector.length,
    model,
    sourceText,
    createdAt: nowS(),
  };
  db()
    .insert(postEmbeddings)
    .values(values)
    .onConflictDoUpdate({ target: postEmbeddings.postId, set: values })
    .run();
}

/** Posts that still need embedding. Cached by post id — embed once, ever. */
export function postsNeedingEmbedding(model: string): { postId: number; text: string }[] {
  return db()
    .select({
      postId: posts.id,
      hook: postFeatures.hookText,
      firstLine: postFeatures.firstLine,
      spoken: postFeatures.spokenHook,
      existingModel: postEmbeddings.model,
    })
    .from(posts)
    .leftJoin(postFeatures, eq(postFeatures.postId, posts.id))
    .leftJoin(postEmbeddings, eq(postEmbeddings.postId, posts.id))
    .all()
    .filter((row) => row.existingModel !== model)
    .map((row) => ({
      postId: row.postId,
      text: buildHookString(row.hook, row.firstLine, row.spoken),
    }))
    .filter((row) => row.text.length > 0);
}

/**
 * The string that gets embedded: caption opening plus the spoken hook when we
 * have one, truncated hard. Reel hooks are spoken or on-screen, so caption-only
 * embedding is guessing at exactly the format that matters most.
 */
export function buildHookString(
  hook: string | null,
  firstLine: string | null,
  spoken: string | null,
): string {
  const parts = [spoken, hook ?? firstLine].filter((p): p is string => !!p && p.trim().length > 0);
  // ~60 tokens. Longer input dilutes the hook with body copy and blurs clusters.
  return [...new Set(parts)].join(' — ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

export interface ClusteringOutcome {
  runId: string;
  k: number;
  silhouette: number;
  sizes: number[];
  representatives: { clusterId: number; size: number; postIds: number[]; examples: string[] }[];
  centroids: Float32Array[];
  assignments: { postId: number; clusterId: number; distance: number }[];
}

export function clusterCorpus(
  embeddings: StoredEmbedding[],
  kMin: number,
  kMax: number,
  onProgress?: (k: number, score: number) => void,
): ClusteringOutcome {
  if (embeddings.length < 10) {
    throw new Error(`Only ${embeddings.length} embedded posts — not enough to cluster meaningfully.`);
  }

  const vectors = embeddings.map((e) => e.vector);
  const result = chooseK(vectors, kMin, kMax, onProgress);
  const reps = representatives(result, 5);

  const sourceTexts = new Map(
    db()
      .select({ postId: postEmbeddings.postId, text: postEmbeddings.sourceText })
      .from(postEmbeddings)
      .all()
      .map((r) => [r.postId, r.text ?? ''] as const),
  );

  return {
    runId: `run-${nowS()}`,
    k: result.k,
    silhouette: result.silhouette,
    sizes: result.sizes,
    centroids: result.centroids,
    representatives: reps.map((indices, clusterId) => ({
      clusterId,
      size: result.sizes[clusterId] ?? 0,
      postIds: indices.map((i) => embeddings[i]!.postId),
      examples: indices.map((i) => sourceTexts.get(embeddings[i]!.postId) ?? ''),
    })),
    assignments: embeddings.map((e, i) => ({
      postId: e.postId,
      clusterId: result.assignments[i]!,
      distance: result.distances[i]!,
    })),
  };
}

/**
 * Persist a clustering run. Names the user set survive by centroid matching:
 * if a new cluster's centre is close to a renamed old one, it inherits the name.
 * Re-clustering must not silently discard my vocabulary.
 */
export function persistClustering(
  outcome: ClusteringOutcome,
  names: { clusterId: number; name: string; description: string }[],
  generatedBy: string,
  renameSimilarityThreshold = 0.82,
): { created: number; inherited: number } {
  const previous = db().select().from(archetypes).where(eq(archetypes.active, true)).all();
  const renamed = previous.filter((a) => a.userRenamed);
  let inherited = 0;

  const run = sqlite().transaction(() => {
    db().update(archetypes).set({ active: false }).where(eq(archetypes.active, true)).run();

    const idByCluster = new Map<number, number>();

    outcome.centroids.forEach((centroid, clusterId) => {
      const generated = names.find((n) => n.clusterId === clusterId);

      let name = generated?.name ?? `archetype ${clusterId + 1}`;
      let description = generated?.description ?? '';
      let userRenamed = false;

      const match = renamed
        .map((a) => ({
          archetype: a,
          similarity: cosineSimilarity(centroid, fromBlob(a.centroid as Buffer, a.dim)),
        }))
        .sort((a, b) => b.similarity - a.similarity)[0];

      if (match && match.similarity >= renameSimilarityThreshold) {
        name = match.archetype.name;
        description = match.archetype.description ?? description;
        userRenamed = true;
        inherited++;
      }

      const row = db()
        .insert(archetypes)
        .values({
          clusterId,
          runId: outcome.runId,
          name,
          description,
          centroid: toBlob(centroid),
          dim: centroid.length,
          size: outcome.sizes[clusterId] ?? 0,
          userRenamed,
          active: true,
          generatedBy,
        })
        .returning({ id: archetypes.id })
        .get();

      idByCluster.set(clusterId, row.id);
    });

    db().delete(postLabels).run();
    for (const assignment of outcome.assignments) {
      const archetypeId = idByCluster.get(assignment.clusterId);
      if (archetypeId === undefined) continue;
      db()
        .insert(postLabels)
        .values({
          postId: assignment.postId,
          archetypeId,
          distance: assignment.distance,
          assignedAt: nowS(),
        })
        .onConflictDoUpdate({
          target: postLabels.postId,
          set: { archetypeId, distance: assignment.distance, assignedAt: nowS() },
        })
        .run();
    }
  });
  run();

  return { created: outcome.centroids.length, inherited };
}

export function activeArchetypes() {
  return db()
    .select()
    .from(archetypes)
    .where(eq(archetypes.active, true))
    .orderBy(sql`${archetypes.size} desc`)
    .all();
}

export function renameArchetype(id: number, name: string, description?: string): void {
  db()
    .update(archetypes)
    .set({
      name,
      ...(description === undefined ? {} : { description }),
      userRenamed: true,
    })
    .where(eq(archetypes.id, id))
    .run();
}

/** Assign a newly-embedded post with no model call at all. */
export function labelNewPosts(embeddings: StoredEmbedding[]): number {
  const active = activeArchetypes();
  if (active.length === 0) return 0;

  const centroids = active.map((a) => fromBlob(a.centroid as Buffer, a.dim));
  const labelled = new Set(
    db().select({ postId: postLabels.postId }).from(postLabels).all().map((r) => r.postId),
  );

  let count = 0;
  for (const embedding of embeddings) {
    if (labelled.has(embedding.postId)) continue;
    const { index, distance } = assignToNearest(embedding.vector, centroids);
    db()
      .insert(postLabels)
      .values({
        postId: embedding.postId,
        archetypeId: active[index]!.id,
        distance,
        assignedAt: nowS(),
      })
      .onConflictDoNothing()
      .run();
    count++;
  }
  return count;
}

/** True once the archetype set has stopped describing the corpus. */
export function shouldRecluster(threshold = 0.2): { drift: number; recommended: boolean } {
  const distances = db().select({ distance: postLabels.distance }).from(postLabels).all();
  const drift = driftFraction(distances.map((d) => d.distance));
  return { drift, recommended: drift > threshold };
}

export interface ArchetypeCrossTab {
  archetypeId: number;
  name: string;
  mine: number;
  niche: number;
  mineShare: number;
  nicheShare: number;
  delta: number;
  medianEngagementRate: number;
  lastUsedByMe: number | null;
}

/**
 * The archetype cross-tab that feeds gap analysis: how often the niche uses
 * each archetype versus how often I do.
 */
export function archetypeCrossTab(): ArchetypeCrossTab[] {
  const rows = db()
    .select({
      archetypeId: postLabels.archetypeId,
      name: archetypes.name,
      role: sql<string>`(select role from accounts where accounts.id = posts.account_id)`,
      takenAt: posts.takenAt,
      engagementRate: postFeatures.engagementRate,
    })
    .from(postLabels)
    .innerJoin(archetypes, eq(archetypes.id, postLabels.archetypeId))
    .innerJoin(posts, eq(posts.id, postLabels.postId))
    .leftJoin(postFeatures, eq(postFeatures.postId, posts.id))
    .where(eq(archetypes.active, true))
    .all();

  const totalMine = rows.filter((r) => r.role === 'self').length;
  const totalNiche = rows.filter((r) => r.role === 'competitor').length;
  const byArchetype = new Map<number, typeof rows>();

  for (const row of rows) {
    const list = byArchetype.get(row.archetypeId) ?? [];
    list.push(row);
    byArchetype.set(row.archetypeId, list);
  }

  return [...byArchetype.entries()]
    .map(([archetypeId, list]) => {
      const mine = list.filter((r) => r.role === 'self');
      const niche = list.filter((r) => r.role === 'competitor');
      const rates = list.map((r) => r.engagementRate ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
      const mineShare = totalMine === 0 ? 0 : mine.length / totalMine;
      const nicheShare = totalNiche === 0 ? 0 : niche.length / totalNiche;

      return {
        archetypeId,
        name: list[0]!.name,
        mine: mine.length,
        niche: niche.length,
        mineShare,
        nicheShare,
        delta: nicheShare - mineShare,
        medianEngagementRate: rates.length ? rates[Math.floor(rates.length / 2)]! : 0,
        lastUsedByMe: mine.length
          ? Math.max(...mine.map((r) => r.takenAt ?? 0)) || null
          : null,
      };
    })
    .sort((a, b) => b.delta - a.delta);
}

export function postsForArchetype(archetypeId: number, limit = 50) {
  return db()
    .select({ post: posts, distance: postLabels.distance })
    .from(postLabels)
    .innerJoin(posts, eq(posts.id, postLabels.postId))
    .where(eq(postLabels.archetypeId, archetypeId))
    .orderBy(postLabels.distance)
    .limit(limit)
    .all();
}

export function archetypeById(id: number) {
  return db().select().from(archetypes).where(eq(archetypes.id, id)).get() ?? null;
}

export function labelsForPosts(postIds: number[]) {
  if (postIds.length === 0) return [];
  return db()
    .select({ postId: postLabels.postId, name: archetypes.name, archetypeId: archetypes.id })
    .from(postLabels)
    .innerJoin(archetypes, eq(archetypes.id, postLabels.archetypeId))
    .where(and(inArray(postLabels.postId, postIds), eq(archetypes.active, true)))
    .all();
}
