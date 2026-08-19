import { formatNumber } from '@/lib/utils';

/**
 * The house style for "we do not know this number".
 *
 * Every analytics view in v2 reads partly-null data — Graph insights only
 * exist for Graph-sourced posts, and only as far back as Meta's lookback
 * reaches. Routing every such cell through one component is what stops a
 * blank from quietly becoming a zero somewhere down the line.
 */
export function Metric({
  value,
  suffix,
  title,
}: {
  value: number | null | undefined;
  suffix?: string;
  title?: string;
}): React.JSX.Element {
  if (value == null) {
    return (
      <span className="text-ink-faint" title={title ?? 'Not available for this post.'}>
        —
      </span>
    );
  }
  return (
    <span className="metric">
      {formatNumber(value)}
      {suffix}
    </span>
  );
}

/** A 0..1 ratio as a percentage, or a blank when it isn't known. */
export function Percent({
  value,
  digits = 1,
  title,
}: {
  value: number | null | undefined;
  digits?: number;
  title?: string;
}): React.JSX.Element {
  if (value == null) {
    return (
      <span className="text-ink-faint" title={title ?? 'Not available for this post.'}>
        —
      </span>
    );
  }
  return <span className="metric">{(value * 100).toFixed(digits)}%</span>;
}

/**
 * Says out loud how much of a view is actually measured. A table where most
 * rows are blank should say so at the top rather than leaving the reader to
 * infer it from the dashes.
 */
export function CoverageNote({
  measured,
  total,
  what,
}: {
  measured: number;
  total: number;
  what: string;
}): React.JSX.Element | null {
  if (total === 0 || measured === total) return null;
  return (
    <div className="border-b border-line bg-signal/[0.06] px-4 py-2 text-[12px] text-signal/90">
      {measured} of {total} {what} have Instagram insights. The rest predate the Graph API
      connection or fall outside Meta&rsquo;s insight lookback — their reach and saves are blank
      rather than zero.
    </div>
  );
}
