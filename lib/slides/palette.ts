/**
 * Curated gradient palette. This is the default and it is fully functional —
 * `IMAGE_PROVIDER=none` is not a degraded mode, it is the intended one. No
 * diffusion model touches lettering; they mangle it, and this is free.
 */

export interface Palette {
  id: string;
  name: string;
  from: string;
  to: string;
  ink: string;
  accent: string;
  muted: string;
}

export const PALETTES: Palette[] = [
  { id: 'ink', name: 'Ink', from: '#0d1117', to: '#1b2430', ink: '#f2efea', accent: '#ffb020', muted: '#9aa3ad' },
  { id: 'clay', name: 'Clay', from: '#2b1d16', to: '#4a2f22', ink: '#f7ede4', accent: '#e8a366', muted: '#c0a894' },
  { id: 'moss', name: 'Moss', from: '#111d18', to: '#1f3a2c', ink: '#eef5ef', accent: '#7fd1a5', muted: '#9bb3a5' },
  { id: 'plum', name: 'Plum', from: '#1c1224', to: '#36203f', ink: '#f4eef7', accent: '#c792ea', muted: '#a898b0' },
  { id: 'slate', name: 'Slate', from: '#12161a', to: '#232b33', ink: '#eceff2', accent: '#5b8def', muted: '#98a2ad' },
  { id: 'sand', name: 'Sand', from: '#f5efe6', to: '#e6dbc9', ink: '#231f1a', accent: '#b4531f', muted: '#6f6558' },
];

export function paletteById(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0]!;
}

/** Stable palette per draft, so regenerating slides doesn't reshuffle the look. */
export function paletteForDraft(draftId: number): Palette {
  return PALETTES[draftId % PALETTES.length]!;
}
