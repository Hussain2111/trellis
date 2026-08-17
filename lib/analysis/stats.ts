/**
 * Small statistics helpers. Everything here is exact arithmetic on numbers we
 * already hold — Layer A of the analysis engine. No model goes near any of it,
 * which is what makes the claims downstream trustworthy regardless of who wrote
 * the sentence around them.
 */

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

/**
 * Robust z-score (median / MAD). Engagement distributions are heavily
 * right-skewed by a handful of hits, and a mean-based z-score lets those hits
 * inflate the baseline they are supposed to be measured against.
 */
export function robustZ(value: number, values: number[]): number {
  const m = median(values);
  const mad = median(values.map((v) => Math.abs(v - m)));
  if (mad === 0) {
    const sd = stdev(values);
    return sd === 0 ? 0 : (value - m) / sd;
  }
  return (0.6745 * (value - m)) / mad;
}

/** Share of `values` at or below `value`, 0..1. */
export function percentileRank(value: number, values: number[]): number {
  if (values.length === 0) return 0;
  return values.filter((v) => v <= value).length / values.length;
}

export function share(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

/** Trailing median over the `window` entries preceding `index` (chronological order). */
export function trailingMedian(values: number[], index: number, window: number): number {
  const start = Math.max(0, index - window);
  const slice = values.slice(start, index);
  return slice.length === 0 ? 0 : median(slice);
}
