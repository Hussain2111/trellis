'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/primitives';

/**
 * The one paid action in v2, so it says what it costs before it runs rather
 * than after. A button that quietly spends the month's scraping budget is a
 * button people click once and then distrust.
 */
export function SnapshotButton({
  costNote,
  disabled,
  disabledReason,
}: {
  costNote: string;
  disabled: boolean;
  disabledReason: string | null;
}): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'confirming' | 'running'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setState('running');
    setError(null);
    try {
      const response = await fetch('/api/followers/snapshot', { method: 'POST' });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Could not start the snapshot.');
      router.refresh();
      setState('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the snapshot.');
      setState('confirming');
    }
  }

  if (disabled) {
    return (
      <div className="text-[12px] text-ink-faint">
        {disabledReason ?? 'Snapshots are unavailable.'}
      </div>
    );
  }

  if (state === 'idle') {
    return (
      <Button variant="primary" onClick={() => setState('confirming')}>
        take a snapshot
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] text-ink-muted">{costNote}</span>
      <Button variant="primary" onClick={() => void run()} disabled={state === 'running'}>
        {state === 'running' ? 'starting…' : 'spend it'}
      </Button>
      <Button variant="ghost" onClick={() => setState('idle')} disabled={state === 'running'}>
        cancel
      </Button>
      {error ? <span className="text-[12px] text-negative">{error}</span> : null}
    </div>
  );
}
