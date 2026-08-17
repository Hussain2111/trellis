/** Float32 vectors stored as SQLite blobs. A few MB for the whole corpus. */

export function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Buffer | Uint8Array, dim: number): Float32Array {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  // Copy rather than view: better-sqlite3 buffers are not guaranteed to be
  // 4-byte aligned, and Float32Array's constructor requires alignment.
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = buffer.readFloatLE(i * 4);
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export function norm(a: Float32Array): number {
  return Math.sqrt(dot(a, a));
}

export function normalize(a: Float32Array): Float32Array {
  const n = norm(a) || 1;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! / n;
  return out;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const denominator = norm(a) * norm(b);
  return denominator === 0 ? 0 : dot(a, b) / denominator;
}

/**
 * Cosine distance, 0..2. Used everywhere instead of Euclidean: embedding
 * magnitude carries no meaning here, only direction does.
 */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  return 1 - cosineSimilarity(a, b);
}

export function centroidOf(vectors: Float32Array[]): Float32Array {
  const dim = vectors[0]?.length ?? 0;
  const out = new Float32Array(dim);
  if (vectors.length === 0) return out;
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) out[i] = out[i]! + v[i]!;
  }
  for (let i = 0; i < dim; i++) out[i] = out[i]! / vectors.length;
  return normalize(out);
}
