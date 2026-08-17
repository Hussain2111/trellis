'use client';

import { useState, useTransition } from 'react';
import { Badge, Button, Input } from '@/components/ui/primitives';
import { rewriteDraftAction } from '@/app/actions';

/** "Make it more ___", holding the voice profile fixed. */
export function RewriteBox({ draftId }: { draftId: number }): React.JSX.Element {
  const [instruction, setInstruction] = useState('');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const presets = ['punchier', 'more specific', 'less salesy', 'shorter', 'more contrarian'];

  const run = (text: string): void => {
    if (!text.trim()) return;
    setError(null);
    start(async () => {
      const result = await rewriteDraftAction(draftId, `Make it ${text.trim()}.`);
      if (result.error) setError(result.error);
      else setInstruction('');
    });
  };

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            disabled={pending}
            onClick={() => run(preset)}
            className="rounded-[3px] border border-line-strong bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-muted hover:border-ink-faint hover:text-ink disabled:opacity-40"
          >
            {preset}
          </button>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <Input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="make it more…"
          disabled={pending}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              run(instruction);
            }
          }}
        />
        <Button size="sm" disabled={pending} onClick={() => run(instruction)}>
          {pending ? 'rewriting…' : 'rewrite'}
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-ink-faint">
        The voice profile stays fixed — &quot;punchier&quot; never means &quot;someone else&apos;s voice&quot;.
      </p>
      {error ? <p className="mt-1.5 text-[11px] text-negative">{error}</p> : null}
    </div>
  );
}

export function CopyButton({ text, label = 'copy caption' }: { text: string; label?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {label}
      </Button>
      {copied ? <Badge tone="good">copied</Badge> : null}
    </span>
  );
}
