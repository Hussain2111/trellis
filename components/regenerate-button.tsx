'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/primitives';

/**
 * Regenerating spends Gemini quota, so this reports what came back rather than
 * silently refreshing — including how many insights validation dropped, which
 * is the number that says whether the model behaved.
 */
export function RegenerateButton({
  kind,
}: {
  kind: 'opportunities' | 'weekly';
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const body = (await response.json()) as {
        error?: string;
        status?: string;
        kept?: number;
        dropped?: number;
        regenerationsUsed?: number;
        regenerationCap?: number;
      };
      if (!response.ok) throw new Error(body.error ?? 'Could not regenerate.');
      setMessage(
        body.status === 'ok'
          ? `Regenerated — ${body.kept} kept${body.dropped ? `, ${body.dropped} dropped in validation` : ''} (${body.regenerationsUsed}/${body.regenerationCap} today)`
          : `Fell back to the deterministic read — nothing survived validation (${body.regenerationsUsed}/${body.regenerationCap} today)`,
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not regenerate.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {message ? <span className="text-[11px] text-ink-faint">{message}</span> : null}
      {error ? <span className="text-[11px] text-negative">{error}</span> : null}
      <Button size="sm" variant="ghost" onClick={() => void run()} disabled={busy}>
        {busy ? 'regenerating…' : 'regenerate'}
      </Button>
    </div>
  );
}
