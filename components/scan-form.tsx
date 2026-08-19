'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Input } from '@/components/ui/primitives';

/**
 * Registers the managed account and pulls it from the Graph API. v1 scraped
 * the handle; v2 uses it as a label and reads the real data off the
 * configured Graph token, so the API answers plainly when that isn't set up
 * rather than queueing a job that fails ten seconds later.
 */
export function ScanForm(): React.JSX.Element {
  const router = useRouter();
  const [handle, setHandle] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setStatus('loading');
    setError(null);
    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Sync failed to start.');
      router.refresh();
      setStatus('idle');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Sync failed to start.');
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex items-center gap-2">
      <Input
        value={handle}
        onChange={(e) => setHandle(e.target.value)}
        placeholder="instagram handle"
        aria-label="Instagram handle"
        disabled={status === 'loading'}
        className="w-56"
      />
      <Button type="submit" variant="primary" disabled={status === 'loading' || !handle.trim()}>
        {status === 'loading' ? 'syncing…' : 'sync'}
      </Button>
      {error ? <span className="text-[12px] text-negative">{error}</span> : null}
    </form>
  );
}
