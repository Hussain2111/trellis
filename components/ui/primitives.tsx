import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A deliberately small primitive set. shadcn-shaped (cva variants, `cn`, plain
 * elements) so `shadcn add` can drop components in later without a rewrite —
 * but nothing here is the default shadcn-on-white look.
 */

export function Panel({
  className,
  children,
  ...props
}: ComponentProps<'section'>): React.JSX.Element {
  return (
    <section
      className={cn('rounded-[4px] border border-line bg-surface', className)}
      {...props}
    >
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  aside,
  className,
}: {
  title: string;
  aside?: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <header
      className={cn(
        'flex items-center justify-between gap-3 border-b border-line px-4 py-2.5',
        className,
      )}
    >
      <h2 className="label">{title}</h2>
      {aside ? <div className="flex items-center gap-2">{aside}</div> : null}
    </header>
  );
}

const badge = cva(
  'inline-flex items-center gap-1.5 rounded-[3px] border px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-[0.06em] uppercase',
  {
    variants: {
      tone: {
        neutral: 'border-line-strong bg-surface-2 text-ink-muted',
        good: 'border-positive/30 bg-positive/10 text-positive',
        bad: 'border-negative/30 bg-negative/10 text-negative',
        signal: 'border-signal/30 bg-signal/10 text-signal',
        info: 'border-info/30 bg-info/10 text-info',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badge>): React.JSX.Element {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}

const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-[3px] border font-medium transition-colors disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        primary: 'border-signal/40 bg-signal/15 text-signal hover:bg-signal/25',
        default: 'border-line-strong bg-surface-2 text-ink hover:border-ink-faint',
        ghost: 'border-transparent text-ink-muted hover:bg-surface-2 hover:text-ink',
        danger: 'border-negative/40 bg-negative/10 text-negative hover:bg-negative/20',
      },
      size: {
        sm: 'h-7 px-2.5 text-[12px]',
        md: 'h-8 px-3 text-[13px]',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof button>): React.JSX.Element {
  return <button className={cn(button({ variant, size }), className)} {...props} />;
}

export function Input({ className, ...props }: ComponentProps<'input'>): React.JSX.Element {
  return (
    <input
      className={cn(
        'h-8 w-full rounded-[3px] border border-line-strong bg-canvas px-2.5 text-[13px] text-ink',
        'placeholder:text-ink-faint focus:border-signal/50 focus:outline-none',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<'select'>): React.JSX.Element {
  return (
    <select
      className={cn(
        'h-8 w-full rounded-[3px] border border-line-strong bg-canvas px-2 text-[13px] text-ink',
        'focus:border-signal/50 focus:outline-none',
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <label className="block space-y-1.5">
      <span className="label block">{label}</span>
      {children}
      {hint ? <span className="block text-[12px] text-ink-faint">{hint}</span> : null}
    </label>
  );
}

/** A single number with its label. The unit of the whole dashboard. */
export function Stat({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'neutral' | 'signal' | 'good' | 'bad';
}): React.JSX.Element {
  const toneClass = {
    neutral: 'text-ink',
    signal: 'text-signal',
    good: 'text-positive',
    bad: 'text-negative',
  }[tone];
  return (
    <div className="px-4 py-3">
      <div className="label">{label}</div>
      <div className={cn('metric mt-1 text-[22px] leading-none', toneClass)}>{value}</div>
      {sub ? <div className="mt-1.5 text-[12px] text-ink-faint">{sub}</div> : null}
    </div>
  );
}

export function Empty({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-[13px] text-ink-muted">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-[12px] text-ink-faint">{detail}</p>
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}
