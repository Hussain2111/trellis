export type DraftFormat = 'carousel' | 'reel' | 'image';

/**
 * The account's own format mix (reel/carousel/image), matched to a target
 * batch size — "format mix (reels vs. carousels vs. single image, in the
 * same proportion the account already posts)". `video` and `unknown` fold
 * into `image` (the closest of the three draft formats to a static video
 * post that isn't a short-form reel).
 */
export function formatMix(postTypes: string[], batchSize: number): DraftFormat[] {
  if (postTypes.length === 0) {
    return evenSplit(batchSize);
  }

  const counts = { reel: 0, carousel: 0, image: 0 };
  for (const type of postTypes) {
    if (type === 'reel' || type === 'video') counts.reel++;
    else if (type === 'carousel') counts.carousel++;
    else counts.image++;
  }

  const total = postTypes.length;
  const raw: Record<DraftFormat, number> = {
    reel: (counts.reel / total) * batchSize,
    carousel: (counts.carousel / total) * batchSize,
    image: (counts.image / total) * batchSize,
  };

  return largestRemainderRound(raw, batchSize);
}

function evenSplit(batchSize: number): DraftFormat[] {
  const formats: DraftFormat[] = ['reel', 'carousel', 'image'];
  const out: DraftFormat[] = [];
  for (let i = 0; i < batchSize; i++) out.push(formats[i % 3]!);
  return out;
}

/** Rounds each share down, then hands the leftover slots to whichever formats had the largest fractional remainder — guarantees the total equals batchSize exactly. */
function largestRemainderRound(raw: Record<DraftFormat, number>, total: number): DraftFormat[] {
  const formats: DraftFormat[] = ['reel', 'carousel', 'image'];
  const floors = formats.map((f) => ({
    format: f,
    floor: Math.floor(raw[f]),
    remainder: raw[f] - Math.floor(raw[f]),
  }));
  let assigned = floors.reduce((sum, f) => sum + f.floor, 0);
  const counts = Object.fromEntries(floors.map((f) => [f.format, f.floor])) as Record<
    DraftFormat,
    number
  >;

  const byRemainder = [...floors].sort((a, b) => b.remainder - a.remainder);
  let i = 0;
  while (assigned < total) {
    const target = byRemainder[i % byRemainder.length]!.format;
    counts[target]++;
    assigned++;
    i++;
  }

  const out: DraftFormat[] = [];
  for (const format of formats) out.push(...Array<DraftFormat>(counts[format]).fill(format));
  return out;
}
