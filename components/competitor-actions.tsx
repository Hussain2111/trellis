'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Input } from '@/components/ui/primitives';

/**
 * Discovery finds accounts that dominate your hashtags, which is not the same
 * set as the accounts you actually consider rivals. v1 had no way to say so;
 * these are that override.
 *
 * Everything here spends Apify credit, so the failure the API returns for an
 * exhausted budget (402, with the shortfall spelled out) is surfaced verbatim
 * rather than flattened into "something went wrong".
 */
export function AddCompetitorForm(): React.JSX.Element {
  const router = useRouter();
  const [handle, setHandle] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setStatus('loading');
    setError(null);
    try {
      const response = await fetch('/api/competitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Could not add that account.');
      setHandle('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that account.');
    } finally {
      setStatus('idle');
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
      <Input
        value={handle}
        onChange={(e) => setHandle(e.target.value)}
        placeholder="add a handle"
        aria-label="Competitor handle"
        disabled={status === 'loading'}
        className="w-48"
      />
      <Button type="submit" variant="primary" disabled={status === 'loading' || !handle.trim()}>
        {status === 'loading' ? 'adding…' : 'add'}
      </Button>
      {error ? <span className="text-[12px] text-negative">{error}</span> : null}
    </form>
  );
}

export function CompetitorRowActions({ id }: { id: number }): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState<'scan' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function scan(): Promise<void> {
    setBusy('scan');
    setError(null);
    try {
      const response = await fetch(`/api/competitors/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scan' }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Could not start the scan.');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the scan.');
    } finally {
      setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    setBusy('remove');
    await fetch(`/api/competitors/${id}`, { method: 'DELETE' });
    router.refresh();
    setBusy(null);
  }

  return (
    <div className="flex items-center justify-end gap-2">
      {error ? <span className="text-[11px] text-negative">{error}</span> : null}
      <Button size="sm" variant="ghost" onClick={() => void scan()} disabled={busy !== null}>
        {busy === 'scan' ? 'scanning…' : 'rescan'}
      </Button>
      {confirmRemove ? (
        <>
          <span className="text-[11px] text-ink-faint">drops their posts too</span>
          <Button size="sm" variant="ghost" onClick={() => void remove()} disabled={busy !== null}>
            confirm
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
            keep
          </Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>
          remove
        </Button>
      )}
    </div>
  );
}
