'use client';

import { useState, useTransition } from 'react';
import { Badge, Button } from '@/components/ui/primitives';
import type { ComponentProps } from 'react';

/**
 * A button that runs a server action and reports what happened. Nothing in this
 * app blocks on a model call, so every one of these enqueues a job and returns
 * immediately — the message it shows is "queued", not "done".
 */
export function ActionButton({
  action,
  label,
  pendingLabel,
  variant = 'default',
  size = 'sm',
  confirm,
}: {
  /**
   * A server action, pre-bound with `.bind(null, …)` when it needs arguments.
   * An arrow wrapper would be a closure, and Server Components cannot pass
   * closures across the boundary.
   */
  action: () => Promise<unknown>;
  label: string;
  pendingLabel?: string;
  variant?: ComponentProps<typeof Button>['variant'];
  size?: ComponentProps<typeof Button>['size'];
  confirm?: string;
}): React.JSX.Element {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant={variant}
        size={size}
        disabled={pending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          start(async () => {
            const outcome = (await action()) as
              | { jobId?: number; error?: string }
              | undefined
              | null;
            if (outcome && typeof outcome === 'object' && 'error' in outcome && outcome.error) {
              setResult({ ok: false, text: String(outcome.error) });
            } else if (outcome && typeof outcome === 'object' && 'jobId' in outcome && outcome.jobId) {
              setResult({ ok: true, text: `queued #${outcome.jobId}` });
            } else {
              setResult({ ok: true, text: 'done' });
            }
          });
        }}
      >
        {pending ? (pendingLabel ?? 'working…') : label}
      </Button>
      {result ? (
        <span className={result.ok ? 'text-[11px] text-ink-faint' : 'text-[11px] text-negative'}>
          {result.ok ? <Badge tone="good">{result.text}</Badge> : result.text}
        </span>
      ) : null}
    </span>
  );
}
