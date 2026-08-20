/**
 * The guard between Gemini's output and the screen.
 *
 * The division of labour in this codebase is that SQL computes every number
 * and Gemini only interprets them. That division is worthless as a stated
 * intention — models are fluent at arithmetic-shaped prose and will produce a
 * plausible median that is simply wrong. So it is enforced here, in code,
 * rather than asked for in a prompt: any figure in the output that does not
 * appear in the input payload gets its insight dropped.
 *
 * Same for citations. An insight that names no post id, or names one not in
 * the payload, is unfalsifiable and does not render.
 */

/** Numbers that are structural rather than claims, and so never need backing. */
const STRUCTURAL = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

export interface ValidationResult<T> {
  kept: T[];
  dropped: { item: T; reason: string }[];
  notes: string[];
}

/**
 * Every number reachable in the payload, plus the roundings a model will
 * legitimately produce from them.
 *
 * A payload median of 3241.5 may honestly be written as "3,241", "3242" or
 * "3241.5"; a rate of 0.0412 as "4.1%" or "4%". Accepting those is not a
 * loophole — the underlying figure is still one SQL computed. Inventing 3,900
 * is what this is for.
 */
export function allowedNumbers(payload: unknown): Set<string> {
  const allowed = new Set<string>();

  const add = (n: number): void => {
    if (!Number.isFinite(n)) return;
    allowed.add(normalise(n));
    allowed.add(normalise(Math.round(n)));
    allowed.add(normalise(Math.floor(n)));
    allowed.add(normalise(Math.ceil(n)));
    allowed.add(normalise(Number(n.toFixed(1))));
    allowed.add(normalise(Number(n.toFixed(2))));
    // A 0..1 ratio is routinely written as a percentage.
    if (n >= 0 && n <= 1) {
      const pct = n * 100;
      allowed.add(normalise(pct));
      allowed.add(normalise(Math.round(pct)));
      allowed.add(normalise(Number(pct.toFixed(1))));
    }
    // A multiplier is routinely written to one decimal place.
    if (n > 1 && n < 1000) allowed.add(normalise(Number(n.toFixed(1))));
  };

  const walk = (value: unknown): void => {
    if (typeof value === 'number') return add(value);
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === 'object') return Object.values(value).forEach(walk);
    // Numeric strings in the payload count too — a date like "2026-08-17"
    // contributes its parts, which is deliberate: a model quoting the week
    // start should not be penalised for it.
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\d+(?:\.\d+)?/g)) add(Number(match[0]));
    }
  };

  walk(payload);
  return allowed;
}

function normalise(n: number): string {
  // -0 and 0 are the same claim.
  return String(Number(n.toFixed(4)) + 0);
}

/** Numbers a piece of prose actually asserts. */
export function numbersIn(text: string): number[] {
  const found: number[] = [];
  // Strips thousands separators so "3,241" reads as one number, not two.
  for (const match of text.replace(/(\d),(?=\d{3}\b)/g, '$1').matchAll(/\d+(?:\.\d+)?/g)) {
    found.push(Number(match[0]));
  }
  return found;
}

/**
 * Numbers in `text` with nothing behind them in the payload.
 * Returns them rather than a boolean so the rejection can say which.
 */
export function unbackedNumbers(text: string, allowed: Set<string>): number[] {
  return numbersIn(text).filter((n) => {
    if (STRUCTURAL.has(n)) return false;
    return !allowed.has(normalise(n));
  });
}

export interface Citable {
  /** Free text that may contain figures. All of it gets checked. */
  prose: string[];
  /** Post ids the claim rests on. */
  postIds: number[];
}

/**
 * Drops any insight that asserts an unbacked figure or cites a post that
 * isn't in the payload.
 *
 * Dropping rather than caveating is deliberate. A wrong number with a hedge
 * attached is still a wrong number on the screen, and the reader has no way to
 * tell which half to trust.
 */
export function validateInsights<T>(
  items: T[],
  payload: unknown,
  extract: (item: T) => Citable,
  options: { requireCitations?: boolean } = {},
): ValidationResult<T> {
  const allowed = allowedNumbers(payload);
  const validIds = new Set(postIdsIn(payload));
  const requireCitations = options.requireCitations ?? true;

  const kept: T[] = [];
  const dropped: { item: T; reason: string }[] = [];

  for (const item of items) {
    const { prose, postIds } = extract(item);

    const unbacked = prose.flatMap((text) => unbackedNumbers(text, allowed));
    if (unbacked.length > 0) {
      dropped.push({
        item,
        reason: `cites ${unbacked.join(', ')}, which ${unbacked.length === 1 ? 'is' : 'are'} not in the payload`,
      });
      continue;
    }

    if (requireCitations && postIds.length === 0) {
      dropped.push({ item, reason: 'cites no posts' });
      continue;
    }

    const unknown = postIds.filter((id) => !validIds.has(id));
    if (unknown.length > 0) {
      dropped.push({ item, reason: `cites post id(s) ${unknown.join(', ')} not in the payload` });
      continue;
    }

    kept.push(item);
  }

  const notes = dropped.map((d) => d.reason);
  return { kept, dropped, notes };
}

/**
 * Post ids anywhere in the payload. Keyed by convention (`postId`, `id`
 * inside a `posts`-ish array) rather than by a rigid schema, so a payload can
 * grow a section without the validator silently stopping to recognise its
 * citations.
 */
export function postIdsIn(payload: unknown): number[] {
  const ids: number[] = [];

  const walk = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) return value.forEach((v) => walk(v, key));
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if ((k === 'postId' || k === 'id' || k === 'postIds') && typeof v === 'number') {
          ids.push(v);
        } else if (k === 'postIds' && Array.isArray(v)) {
          for (const n of v) if (typeof n === 'number') ids.push(n);
        } else {
          walk(v, k);
        }
      }
    }
  };

  walk(payload);
  return ids;
}
