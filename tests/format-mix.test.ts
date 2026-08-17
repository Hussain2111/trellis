import { describe, expect, it } from 'vitest';
import { formatMix } from '../lib/analysis/format-mix';

describe('formatMix', () => {
  it("matches the account's own proportions", () => {
    // 6 reel, 3 carousel, 1 image out of 10 -> scaled to 12.
    const types = [...Array(6).fill('reel'), ...Array(3).fill('carousel'), 'image'];
    const mix = formatMix(types, 12);
    expect(mix).toHaveLength(12);
    const counts = {
      reel: mix.filter((f) => f === 'reel').length,
      carousel: mix.filter((f) => f === 'carousel').length,
      image: mix.filter((f) => f === 'image').length,
    };
    expect(counts.reel).toBe(7); // 6/10*12 = 7.2 -> rounds
    expect(counts.reel + counts.carousel + counts.image).toBe(12);
  });

  it('always sums to exactly the batch size regardless of rounding', () => {
    for (const types of [
      Array(7).fill('reel'),
      [...Array(1).fill('reel'), ...Array(1).fill('carousel'), ...Array(1).fill('image')],
      Array(5).fill('carousel'),
    ]) {
      const mix = formatMix(types, 12);
      expect(mix).toHaveLength(12);
    }
  });

  it('folds video and unknown into the nearest bucket', () => {
    const mix = formatMix(['video', 'video', 'unknown'], 3);
    expect(mix.filter((f) => f === 'reel')).toHaveLength(2);
    expect(mix.filter((f) => f === 'image')).toHaveLength(1);
  });

  it('falls back to an even split with no post history', () => {
    const mix = formatMix([], 12);
    expect(mix).toHaveLength(12);
    expect(new Set(mix).size).toBeGreaterThan(1);
  });
});
