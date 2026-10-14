import type { ReactNode } from 'react';

/**
 * Empty and thin-data states are components, not leftovers.
 *
 * This product is sparse on day one by design and possibly for a while. A blank
 * that explains itself is the product working, so the explaining is built in
 * rather than being whatever is left when data is missing.
 */

export function Panel({ children }: { children: ReactNode }) {
  return <section className="rounded-xl border border-rule bg-card shadow-sm">{children}</section>;
}

export function PanelHeader({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <header className="flex items-baseline justify-between gap-3 border-b border-rule px-5 py-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {aside ? <div className="text-xs text-ink-faint">{aside}</div> : null}
    </header>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-5 py-10 text-center">
      <p className="text-sm font-medium text-ink-muted">{title}</p>
      {children ? <p className="mx-auto mt-2 max-w-sm text-sm text-ink-faint">{children}</p> : null}
    </div>
  );
}

/**
 * A number, or an honest blank.
 *
 * `value === null` renders an em dash and, on request, why. It never renders 0
 * for an unknown — summing an empty series gives 0, which reads as "you held
 * steady", a different and false claim.
 *
 * Numbers are grouped (4,876 rather than 4876). At a glance 4876 and 48765 are
 * the same shape, and this is read at a glance.
 */
export function Stat({
  label,
  value,
  unknownReason,
  note,
  marked,
}: {
  label: string;
  value: number | string | null;
  unknownReason?: string;
  /** A short qualifier — a sample size, a comparison. Shown only when it says something. */
  note?: string;
  /** Ties the figure to a footnote below the group rather than repeating the caveat on each. */
  marked?: boolean;
}) {
  const known = value !== null && value !== undefined;
  return (
    <div className="px-5 py-4">
      <div className="text-xs uppercase tracking-wide text-ink-faint">
        {label}
        {marked ? <span className="text-accent"> *</span> : null}
      </div>
      <div className="tabular mt-1 text-2xl font-semibold">
        {known ? format(value) : <span className="text-ink-faint">—</span>}
      </div>
      {!known && unknownReason ? (
        <div className="mt-1 text-xs text-ink-faint">{unknownReason}</div>
      ) : null}
      {known && note ? <div className="mt-1 text-xs text-ink-faint">{note}</div> : null}
    </div>
  );
}

function format(value: number | string): string {
  return typeof value === 'number' ? value.toLocaleString('en-US') : value;
}

/**
 * Every aggregate declares its real sample size — but only where the sample is
 * not the whole window. Repeating "30 of 30 days" under five figures in a row
 * is noise that trains the eye to skip the one that reads "25 of 30".
 */
export function sampleNote(
  measured: number,
  total: number,
  unit: 'day' | 'post',
): string | undefined {
  if (total === 0 || measured === total) return undefined;
  return `${measured} of ${total} ${unit}s measured`;
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'bad';
}) {
  const tones = {
    neutral: 'bg-paper-sunk text-ink-muted',
    good: 'bg-positive/10 text-positive',
    bad: 'bg-negative-soft text-negative',
  } as const;
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}
