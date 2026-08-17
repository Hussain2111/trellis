import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from './primitives';

/** Shared display pieces for the dense, numeric parts of the app. */

export function Delta({
  value,
  suffix = 'pts',
  invert = false,
}: {
  value: number;
  suffix?: string;
  invert?: boolean;
}): React.JSX.Element {
  const positive = invert ? value < 0 : value > 0;
  const negligible = Math.abs(value) < 0.005;
  return (
    <span
      className={cn(
        'metric text-[12px]',
        negligible ? 'text-ink-faint' : positive ? 'text-positive' : 'text-negative',
      )}
    >
      {value > 0 ? '+' : ''}
      {(value * 100).toFixed(0)} {suffix}
    </span>
  );
}

/** A percentage with its sample size beside it — never one without the other. */
export function Share({ share, n, total }: { share: number; n: number; total: number }): React.JSX.Element {
  return (
    <span className="metric whitespace-nowrap">
      {(share * 100).toFixed(0)}%
      <span className="ml-1 text-[11px] text-ink-faint">
        ({n}/{total})
      </span>
    </span>
  );
}

export function GeneratedBy({ value }: { value: string | null }): React.JSX.Element | null {
  if (!value) return null;
  const degraded = value.includes('degraded');
  const repaired = value.includes('repaired');
  return (
    <Badge tone={degraded || repaired ? 'signal' : 'neutral'} title={value}>
      {value.split(' ')[0]}
      {degraded ? ' ·degraded' : ''}
      {repaired ? ' ·repaired' : ''}
    </Badge>
  );
}

export function Bar({ value, max, tone = 'signal' }: { value: number; max: number; tone?: 'signal' | 'muted' }): React.JSX.Element {
  const pct = max === 0 ? 0 : Math.min(100, (value / max) * 100);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <div
        className={cn('h-full', tone === 'signal' ? 'bg-signal' : 'bg-ink-faint')}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Table({
  head,
  children,
}: {
  head: string[];
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-line text-left">
            {head.map((h) => (
              <th key={h} className="label px-4 py-1.5 font-normal whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export function PoolWarning({ warning }: { warning: string | null }): React.JSX.Element | null {
  if (!warning) return null;
  return (
    <div className="border-b border-line bg-signal/[0.06] px-4 py-2 text-[12px] text-signal/90">
      {warning}
    </div>
  );
}
