import { describe, expect, it } from 'vitest';
import {
  assignToNearest,
  chooseK,
  driftFraction,
  kmeans,
  representatives,
  silhouetteScore,
} from '@/lib/analysis/cluster';
import { centroidOf, cosineDistance, cosineSimilarity, fromBlob, normalize, toBlob } from '@/lib/analysis/vector';

/** Three well-separated blobs in 8 dimensions. */
function blobs(perCluster = 20, dim = 8): { vectors: Float32Array[]; truth: number[] } {
  const centres = [0, 1, 2].map((c) => {
    const v = new Float32Array(dim);
    v[c] = 1;
    v[(c + 3) % dim] = 0.5;
    return v;
  });

  const vectors: Float32Array[] = [];
  const truth: number[] = [];
  let seed = 1;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };

  for (let c = 0; c < centres.length; c++) {
    for (let i = 0; i < perCluster; i++) {
      const v = new Float32Array(dim);
      for (let d = 0; d < dim; d++) v[d] = (centres[c]![d] ?? 0) + rand() * 0.08;
      vectors.push(normalize(v));
      truth.push(c);
    }
  }
  return { vectors, truth };
}

describe('vector storage', () => {
  it('survives a blob round trip', () => {
    const v = normalize(Float32Array.from([1, 2, 3, 4]));
    const back = fromBlob(toBlob(v), 4);
    for (let i = 0; i < 4; i++) expect(back[i]).toBeCloseTo(v[i]!, 6);
  });

  it('measures direction, not magnitude', () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = Float32Array.from([10, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1);
    expect(cosineDistance(a, b)).toBeCloseTo(0);
  });

  it('averages then re-normalises a centroid', () => {
    const c = centroidOf([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
    expect(Math.hypot(c[0]!, c[1]!)).toBeCloseTo(1);
  });
});

describe('k-means', () => {
  it('recovers well-separated clusters', () => {
    const { vectors, truth } = blobs();
    const result = kmeans(vectors, 3);

    // Cluster ids are arbitrary; what matters is that points sharing a true
    // cluster end up sharing an assigned one.
    const mapping = new Map<number, number>();
    let consistent = 0;
    for (let i = 0; i < vectors.length; i++) {
      const t = truth[i]!;
      const a = result.assignments[i]!;
      if (!mapping.has(t)) mapping.set(t, a);
      if (mapping.get(t) === a) consistent++;
    }
    expect(consistent / vectors.length).toBeGreaterThan(0.95);
  });

  it('is deterministic across runs', () => {
    const { vectors } = blobs();
    const a = kmeans(vectors, 3);
    const b = kmeans(vectors, 3);
    expect(a.assignments).toEqual(b.assignments);
    expect(a.silhouette).toBeCloseTo(b.silhouette, 10);
  });

  it('never returns an empty cluster', () => {
    const { vectors } = blobs(10);
    const result = kmeans(vectors, 6);
    expect(result.sizes.every((s) => s > 0)).toBe(true);
    expect(result.sizes.reduce((a, b) => a + b, 0)).toBe(vectors.length);
  });

  it('scores separated data higher than noise', () => {
    const { vectors } = blobs();
    const separated = kmeans(vectors, 3);

    const noise = Array.from({ length: 60 }, (_, i) => {
      const v = new Float32Array(8);
      for (let d = 0; d < 8; d++) v[d] = Math.sin(i * 7 + d * 13);
      return normalize(v);
    });
    const noisy = kmeans(noise, 3);

    expect(separated.silhouette).toBeGreaterThan(noisy.silhouette);
  });

  it('silhouette is zero when there is nothing to separate', () => {
    expect(silhouetteScore([], [], [])).toBe(0);
    const { vectors } = blobs(5);
    expect(silhouetteScore(vectors, new Array(15).fill(0), [vectors[0]!])).toBe(0);
  });
});

describe('k selection', () => {
  it('picks the true number of clusters on clean data', () => {
    const { vectors } = blobs(25);
    const result = chooseK(vectors, 2, 8);
    expect(result.k).toBe(3);
  });

  it('caps k so clusters are never smaller than a few posts', () => {
    const { vectors } = blobs(3); // 9 vectors
    const result = chooseK(vectors, 8, 20);
    expect(result.k).toBeLessThanOrEqual(3);
  });

  it('reports the k it tried', () => {
    const seen: number[] = [];
    chooseK(blobs(20).vectors, 2, 5, (k) => seen.push(k));
    expect(seen).toEqual([2, 3, 4, 5]);
  });
});

describe('assignment and drift', () => {
  it('assigns a new point to its nearest centroid with no model call', () => {
    const { vectors } = blobs();
    const result = kmeans(vectors, 3);
    const probe = vectors[0]!;
    const { index, distance } = assignToNearest(probe, result.centroids);
    expect(index).toBe(result.assignments[0]);
    expect(distance).toBeLessThan(0.2);
  });

  it('measures how much of the corpus the archetypes no longer describe', () => {
    expect(driftFraction([])).toBe(0);
    expect(driftFraction([0.1, 0.2, 0.9, 0.95], 0.55)).toBe(0.5);
  });

  it('returns the posts nearest each centroid for naming', () => {
    const { vectors } = blobs();
    const result = kmeans(vectors, 3);
    const reps = representatives(result, 5);
    expect(reps).toHaveLength(3);
    for (const cluster of reps) expect(cluster.length).toBeLessThanOrEqual(5);

    // Representatives must be the closest members, in order.
    const first = reps[0]!;
    const distances = first.map((i) => result.distances[i]!);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
  });
});
