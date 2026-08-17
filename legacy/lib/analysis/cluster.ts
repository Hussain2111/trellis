import { centroidOf, cosineDistance, normalize } from './vector';

/**
 * Spherical k-means over hook embeddings, with k chosen by silhouette score.
 *
 * This replaces per-post LLM classification entirely. Beyond being free and
 * instant, it is *better*: archetypes are derived from the actual corpus rather
 * than invented by a model guessing at what categories should exist, and the
 * label set is stable by construction — which is exactly what a claim like
 * "51% vs your 20%" depends on. A small local model let loose on free-form
 * labelling produces 200 near-duplicate archetypes and quietly destroys the
 * benchmark.
 *
 * Deterministic: k-means++ seeding is driven by a seeded PRNG so the same
 * corpus always produces the same clusters.
 */

export interface ClusterResult {
  k: number;
  assignments: number[];
  centroids: Float32Array[];
  distances: number[];
  silhouette: number;
  sizes: number[];
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k-means++ seeding: spreads initial centroids out, which matters a lot here. */
function seedCentroids(vectors: Float32Array[], k: number, rng: () => number): Float32Array[] {
  const centroids: Float32Array[] = [];
  const first = Math.floor(rng() * vectors.length);
  centroids.push(vectors[first]!);

  while (centroids.length < k) {
    const distances = vectors.map((v) =>
      Math.min(...centroids.map((c) => cosineDistance(v, c))) ** 2,
    );
    const total = distances.reduce((a, b) => a + b, 0);
    if (total === 0) {
      centroids.push(vectors[Math.floor(rng() * vectors.length)]!);
      continue;
    }
    let target = rng() * total;
    let index = 0;
    for (let i = 0; i < distances.length; i++) {
      target -= distances[i]!;
      if (target <= 0) {
        index = i;
        break;
      }
    }
    centroids.push(vectors[index]!);
  }
  return centroids;
}

export function kmeans(
  vectors: Float32Array[],
  k: number,
  options: { maxIterations?: number; seed?: number } = {},
): ClusterResult {
  const maxIterations = options.maxIterations ?? 50;
  const rng = mulberry32(options.seed ?? 1337);
  const unit = vectors.map(normalize);

  let centroids = seedCentroids(unit, k, rng);
  let assignments = new Array<number>(unit.length).fill(0);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let changed = false;

    for (let i = 0; i < unit.length; i++) {
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let c = 0; c < centroids.length; c++) {
        const d = cosineDistance(unit[i]!, centroids[c]!);
        if (d < bestDistance) {
          bestDistance = d;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }

    const next: Float32Array[] = [];
    for (let c = 0; c < k; c++) {
      const members = unit.filter((_, i) => assignments[i] === c);
      // An empty cluster is re-seeded on the point furthest from its centroid
      // rather than dropped, so k stays what was asked for.
      next.push(members.length > 0 ? centroidOf(members) : furthestPoint(unit, centroids, rng));
    }
    centroids = next;

    if (!changed) break;
  }

  const distances = unit.map((v, i) => cosineDistance(v, centroids[assignments[i]!]!));
  const sizes = Array.from({ length: k }, (_, c) => assignments.filter((a) => a === c).length);

  return {
    k,
    assignments,
    centroids,
    distances,
    silhouette: silhouetteScore(unit, assignments, centroids),
    sizes,
  };
}

function furthestPoint(
  vectors: Float32Array[],
  centroids: Float32Array[],
  rng: () => number,
): Float32Array {
  let best = vectors[Math.floor(rng() * vectors.length)]!;
  let bestDistance = -1;
  for (const v of vectors) {
    const d = Math.min(...centroids.map((c) => cosineDistance(v, c)));
    if (d > bestDistance) {
      bestDistance = d;
      best = v;
    }
  }
  return best;
}

/**
 * Silhouette against centroids rather than all pairs: O(n·k) instead of O(n²).
 * On 1,100 posts the exact version would be 1.2M distance computations per
 * candidate k, and the approximation ranks k identically in practice.
 */
export function silhouetteScore(
  vectors: Float32Array[],
  assignments: number[],
  centroids: Float32Array[],
): number {
  if (centroids.length < 2 || vectors.length === 0) return 0;
  let total = 0;

  for (let i = 0; i < vectors.length; i++) {
    const own = assignments[i]!;
    const a = cosineDistance(vectors[i]!, centroids[own]!);
    let b = Number.POSITIVE_INFINITY;
    for (let c = 0; c < centroids.length; c++) {
      if (c === own) continue;
      b = Math.min(b, cosineDistance(vectors[i]!, centroids[c]!));
    }
    const denominator = Math.max(a, b);
    total += denominator === 0 ? 0 : (b - a) / denominator;
  }

  return total / vectors.length;
}

/**
 * Try each k in range and keep the best silhouette. The range is bounded
 * because the output is a *label set a human reads*: under 8 archetypes is too
 * coarse to act on, over 20 is a list nobody can hold in their head.
 */
export function chooseK(
  vectors: Float32Array[],
  kMin: number,
  kMax: number,
  onProgress?: (k: number, score: number) => void,
): ClusterResult {
  const upper = Math.min(kMax, Math.floor(vectors.length / 3));
  const lower = Math.min(kMin, upper);
  if (upper < 2) return kmeans(vectors, Math.max(1, vectors.length > 0 ? 1 : 0));

  let best: ClusterResult | null = null;
  for (let k = lower; k <= upper; k++) {
    const result = kmeans(vectors, k);
    onProgress?.(k, result.silhouette);
    if (!best || result.silhouette > best.silhouette) best = result;
  }
  return best!;
}

/** Nearest centroid for a new post — no model call involved. */
export function assignToNearest(
  vector: Float32Array,
  centroids: Float32Array[],
): { index: number; distance: number } {
  let index = 0;
  let distance = Number.POSITIVE_INFINITY;
  const unit = normalize(vector);
  for (let c = 0; c < centroids.length; c++) {
    const d = cosineDistance(unit, centroids[c]!);
    if (d < distance) {
      distance = d;
      index = c;
    }
  }
  return { index, distance };
}

/**
 * Fraction of posts that sit far from every centroid. Past ~20% the archetype
 * set no longer describes the corpus and it is worth re-clustering.
 */
export function driftFraction(distances: number[], threshold = 0.55): number {
  if (distances.length === 0) return 0;
  return distances.filter((d) => d > threshold).length / distances.length;
}

/** The `n` posts closest to each centroid — the examples sent for naming. */
export function representatives(
  result: ClusterResult,
  n: number,
): number[][] {
  const byCluster: { index: number; distance: number }[][] = Array.from(
    { length: result.k },
    () => [],
  );
  result.assignments.forEach((cluster, index) => {
    byCluster[cluster]!.push({ index, distance: result.distances[index]! });
  });
  return byCluster.map((list) =>
    list
      .sort((a, b) => a.distance - b.distance)
      .slice(0, n)
      .map((entry) => entry.index),
  );
}
