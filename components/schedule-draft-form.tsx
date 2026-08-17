'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Input } from '@/components/ui/primitives';

/** Schedules a draft for a future time. Whether it actually posts itself is a
 * separate question — see ENABLE_IG_PUBLISHING in Settings. */
export function ScheduleDraftForm({ draftId }: { draftId: number }): React.JSX.Element {
  const router = useRouter();
  const [when, setWhen] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!when) return;
    setStatus('loading');
    setError(null);
    try {
      const response = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId, scheduledFor: new Date(when).toISOString() }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Failed to schedule.');
      router.refresh();
      setStatus('idle');
      setWhen('');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Failed to schedule.');
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex items-center gap-2">
      <Input
        type="datetime-local"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
        aria-label="Schedule for"
        className="w-48"
        disabled={status === 'loading'}
      />
      <Button type="submit" size="sm" variant="primary" disabled={status === 'loading' || !when}>
        schedule
      </Button>
      {error ? <span className="text-[12px] text-negative">{error}</span> : null}
    </form>
  );
}
