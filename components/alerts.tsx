'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Alert } from '@/lib/alerts';
import { loadAlerts } from '@/lib/client/alerts';
import { CloseIcon } from './icons';

/**
 * In-app alerts, and in-app is the whole specification. No email, no push, no
 * third-party service — the product is one person's own account and the place
 * they read it is here.
 *
 * Dismissal is per viewer and lives in this browser. An alert's id carries the
 * figures it is about, so dismissing "you lost 9 followers on the 26th" hides
 * that and nothing else: tomorrow's movement is a different alert with a
 * different id and shows up again.
 */
const DISMISSED_KEY = 'trellis.dismissed-alerts';

const TONE: Record<Alert['tone'], string> = {
  positive: 'border-positive/40 bg-positive/10',
  negative: 'border-negative/40 bg-negative-soft',
  neutral: 'border-rule bg-paper-sunk',
};

export function Alerts() {
  const pathname = usePathname();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);

  useEffect(() => {
    let cancelled = false;
    void loadAlerts(pathname).then((result) => {
      if (!cancelled) setAlerts(result.alerts);
    });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const showing = alerts.filter((alert) => !dismissed.includes(alert.id));
  if (showing.length === 0) return null;

  function dismiss(id: string) {
    const next = [...dismissed, id];
    setDismissed(next);
    writeDismissed(next);
  }

  return (
    <div className="mb-6 space-y-2">
      {showing.map((alert) => (
        <div
          key={alert.id}
          className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${TONE[alert.tone]}`}
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {alert.href ? (
                <Link href={alert.href} className="hover:underline">
                  {alert.title}
                </Link>
              ) : (
                alert.title
              )}
            </p>
            {alert.detail ? <p className="mt-0.5 text-xs text-ink-muted">{alert.detail}</p> : null}
          </div>
          <button
            type="button"
            onClick={() => dismiss(alert.id)}
            aria-label="Dismiss"
            className="shrink-0 rounded-md p-1 text-ink-faint hover:text-ink"
          >
            <CloseIcon className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Storage can be absent or refused — a private window, cleared site data, a
 * browser set to block it. Every read and write is guarded, and the page is
 * correct with nothing stored: it simply shows the alerts.
 */
function readDismissed(): string[] {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: string[]): void {
  try {
    // Ids grow as figures change, so the list is trimmed rather than kept
    // forever. Anything this old is long gone from the screen anyway.
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(-50)));
  } catch {
    // Nothing to do, and nothing worth telling the reader about.
  }
}
