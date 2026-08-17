import { describe, expect, it } from 'vitest';
import { slidesForDraft } from '../lib/slides/render';
import { paletteForDraft, paletteById, PALETTES } from '../lib/slides/palette';

describe('slidesForDraft', () => {
  it('builds hook, body slides, and cta in order', () => {
    const body = {
      kind: 'carousel',
      slides: [
        { heading: 'Slide 1', body: 'Body 1' },
        { heading: 'Slide 2', body: 'Body 2' },
      ],
    };
    const specs = slidesForDraft(body, 'The hook', 'Follow for more');
    expect(specs.map((s) => s.kind)).toEqual(['hook', 'body', 'body', 'cta']);
    expect(specs[0]?.heading).toBe('The hook');
    expect(specs[1]?.heading).toBe('Slide 1');
    expect(specs[3]?.heading).toBe('Follow for more');
  });

  it('omits the cta slide when there is no cta', () => {
    const specs = slidesForDraft({ kind: 'carousel', slides: [] }, 'Hook only', null);
    expect(specs.map((s) => s.kind)).toEqual(['hook']);
  });

  it('is just a hook slide for a non-carousel body', () => {
    const specs = slidesForDraft(
      { kind: 'image', concept: 'x', image_direction: 'y' },
      'Hook',
      'CTA',
    );
    expect(specs.map((s) => s.kind)).toEqual(['hook', 'cta']);
  });
});

describe('paletteForDraft', () => {
  it('is stable for the same draft id — a re-render never reshuffles the look', () => {
    expect(paletteForDraft(7)).toBe(paletteForDraft(7));
  });

  it('cycles through the curated palette set', () => {
    expect(paletteForDraft(0)).toBe(PALETTES[0]);
    expect(paletteForDraft(PALETTES.length)).toBe(PALETTES[0]);
  });
});

describe('paletteById', () => {
  it('falls back to the first palette for an unknown id', () => {
    expect(paletteById('does-not-exist')).toBe(PALETTES[0]);
  });
});
