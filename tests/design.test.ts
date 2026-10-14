import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A guard for a failure that produced no error anywhere.
 *
 * Every colour in this app was written the bracket shorthand. In Tailwind 4.0
 * that bracket form was shorthand for the variable; 4.1 removed it. It does not
 * warn, it does not fail the build — it emits `background-color: --color-card`,
 * which is not valid CSS, so the browser drops the declaration and the rule
 * silently does nothing.
 *
 * The result was an app with no design system applied at all: no card
 * backgrounds, no rules, no ink scale, and an overlay you could read straight
 * through. It rendered, it type-checked, it deployed, and it was wrong on every
 * screen. Tokens declared in `@theme` generate real utilities — `bg-card`,
 * `text-ink-faint`, `rounded-note` — so those are what get used.
 */
const SOURCE_DIRS = ['app', 'components'];
const BRACKET_TOKEN = /-\[--(?:color|radius|shadow|font)-[a-z0-9-]+\]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe('design tokens reach the browser', () => {
  it('never uses the bracket shorthand Tailwind stopped resolving', () => {
    const offenders = SOURCE_DIRS.flatMap(sourceFiles)
      .map((file) => ({ file, lines: readFileSync(file, 'utf8').split('\n') }))
      .flatMap(({ file, lines }) =>
        lines
          .map((line, i) => ({ file, line: i + 1, text: line.trim() }))
          .filter((entry) => BRACKET_TOKEN.test(entry.text)),
      )
      .map((entry) => `${entry.file}:${entry.line}`);

    expect(offenders).toEqual([]);
  });
});

/** Validate the actual shared tokens, including the system-dark overrides. */
const css = readFileSync('app/globals.css', 'utf8');
const base = tokens(css.split('@media')[0]!);
const dark = { ...base, ...tokens(css.split('@media')[1]!) };

function tokens(source: string): Record<string, string> {
  return Object.fromEntries(
    [...source.matchAll(/--color-([a-z0-9-]+):\s*(#[a-f0-9]{6})/gi)].map((match) => [
      match[1]!,
      match[2]!,
    ]),
  );
}

function luminance(hex: string): number {
  return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
    const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return sum + weight * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  }, 0);
}

function contrast(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high! + 0.05) / (low! + 0.05);
}

describe.each([
  ['light', base],
  ['dark', dark],
] as const)('%s palette contrast', (_theme, palette) => {
  const surfaces = [
    'paper',
    'paper-sunk',
    'card',
    'accent-soft',
    ...Array.from({ length: 6 }, (_, i) => `note-${i + 1}`),
  ];

  it('keeps normal and muted text readable on every ordinary surface', () => {
    for (const foreground of ['ink', 'ink-muted', 'ink-faint']) {
      for (const background of surfaces) {
        expect(
          contrast(palette[foreground]!, palette[background]!),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const background of ['paper', 'paper-sunk', 'card', 'accent-soft']) {
      expect(
        contrast(palette.accent!, palette[background]!),
        `accent on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps filled action labels and interactive edges distinguishable', () => {
    for (const background of ['action', 'action-hover']) {
      expect(contrast(palette['on-action']!, palette[background]!)).toBeGreaterThanOrEqual(4.5);
    }
    for (const background of ['paper', 'paper-sunk', 'card']) {
      for (const foreground of ['control', 'action-edge', 'accent']) {
        expect(
          contrast(palette[foreground]!, palette[background]!),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('preserves readable error and success colors', () => {
    for (const background of ['paper', 'card', 'negative-soft']) {
      expect(contrast(palette.negative!, palette[background]!)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(palette.positive!, palette.card!)).toBeGreaterThanOrEqual(4.5);
    expect(palette.negative).not.toBe(palette.accent);
    expect(palette.positive).not.toBe(palette.accent);
  });
});

it('uses the filled-action tokens wherever a white label sits on an accent fill', () => {
  const offenders = SOURCE_DIRS.flatMap(sourceFiles).filter((file) =>
    /bg-accent\b[^'"\n]*text-(?:white|on-action)/.test(readFileSync(file, 'utf8')),
  );
  expect(offenders).toEqual([]);
});
