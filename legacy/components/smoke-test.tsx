'use client';

import { useState, useTransition } from 'react';
import { smokeTestAction, type SmokeTestOutcome } from '@/app/actions';
import { Badge, Button } from '@/components/ui/primitives';

export function SmokeTest({ tier, label }: { tier: 'A' | 'B'; label: string }): React.JSX.Element {
  const [pending, start] = useTransition();
  const [outcome, setOutcome] = useState<SmokeTestOutcome | null>(null);

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setOutcome(await smokeTestAction(tier));
          })
        }
      >
        {pending ? 'testing…' : label}
      </Button>
      {outcome ? (
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone={outcome.ok ? 'good' : 'bad'}>{outcome.ok ? 'ok' : 'failed'}</Badge>
          {outcome.generatedBy ? (
            <span className="font-mono text-[11px] text-ink-faint">{outcome.generatedBy}</span>
          ) : null}
          {outcome.durationMs ? (
            <span className="metric text-[11px] text-ink-faint">
              {(outcome.durationMs / 1000).toFixed(1)}s
            </span>
          ) : null}
          <span className="truncate text-[11px] text-ink-faint">{outcome.detail}</span>
        </div>
      ) : null}
    </div>
  );
}
