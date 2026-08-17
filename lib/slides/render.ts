import fs from 'node:fs';
import path from 'node:path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { Slide, SLIDE_SIZE, type SlideKind } from './template';
import { paletteForDraft, type Palette } from './palette';

/**
 * Slide text is always rendered deterministically. Backgrounds may or may not
 * come from a model; lettering never does.
 */

let fontCache: { name: string; data: Buffer; weight: 400 | 700; style: 'normal' }[] | null = null;

/**
 * satori needs real font bytes, and it reads TTF/OTF/WOFF only — not WOFF2, and
 * not variable axes. The UI's `@fontsource-variable/*` packages ship variable
 * woff2 exclusively, so the static `@fontsource/*` siblings are installed
 * alongside them purely for rendering. Both are on disk; nothing is downloaded.
 */
function loadFonts(): { name: string; data: Buffer; weight: 400 | 700; style: 'normal' }[] {
  if (fontCache) return fontCache;

  const candidates: { name: string; file: string; weight: 400 | 700 }[] = [
    { name: 'Inter', file: '@fontsource/inter/files/inter-latin-400-normal.woff', weight: 400 },
    { name: 'Inter', file: '@fontsource/inter/files/inter-latin-700-normal.woff', weight: 700 },
    {
      name: 'JetBrains Mono',
      file: '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff',
      weight: 400,
    },
  ];

  const fonts: { name: string; data: Buffer; weight: 400 | 700; style: 'normal' }[] = [];
  for (const candidate of candidates) {
    const file = path.join(process.cwd(), 'node_modules', candidate.file);
    if (!fs.existsSync(file)) continue;
    fonts.push({
      name: candidate.name,
      data: fs.readFileSync(file),
      weight: candidate.weight,
      style: 'normal',
    });
  }

  if (fonts.length === 0) {
    throw new Error(
      'No font files found for slide rendering. Run `npm install` — @fontsource/inter provides the static WOFF that satori needs.',
    );
  }
  fontCache = fonts;
  return fonts;
}

export interface SlideSpec {
  kind: SlideKind;
  heading: string;
  body?: string;
}

export async function renderSlide(options: {
  spec: SlideSpec;
  index: number;
  total: number;
  handle: string;
  palette: Palette;
  backgroundImage?: string;
}): Promise<Buffer> {
  const svg = await satori(
    Slide({
      kind: options.spec.kind,
      index: options.index,
      total: options.total,
      heading: options.spec.heading,
      ...(options.spec.body === undefined ? {} : { body: options.spec.body }),
      handle: options.handle,
      palette: options.palette,
      ...(options.backgroundImage === undefined
        ? {}
        : { backgroundImage: options.backgroundImage }),
    }),
    { width: SLIDE_SIZE, height: SLIDE_SIZE, fonts: loadFonts() },
  );

  const png = new Resvg(svg, { fitTo: { mode: 'width', value: SLIDE_SIZE } }).render().asPng();
  return Buffer.from(png);
}

/** A carousel body → the slide sequence: hook, bodies, CTA. */
export function slidesForDraft(body: unknown, hook: string, cta: string | null): SlideSpec[] {
  const specs: SlideSpec[] = [{ kind: 'hook', heading: hook }];

  if (body && typeof body === 'object' && (body as { kind?: string }).kind === 'carousel') {
    const slides = (body as { slides: { heading: string; body: string }[] }).slides;
    for (const slide of slides) {
      specs.push({ kind: 'body', heading: slide.heading, body: slide.body });
    }
  }

  if (cta) specs.push({ kind: 'cta', heading: cta });
  return specs;
}

export { paletteForDraft };
