'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Pokes the job queue every 10s while the dashboard is open, so a scan's
 * chained pipeline (features → hooks → analysis → voice → drafts) actually
 * runs to completion instead of sitting pending until the next daily cron. */
export function PipelineTickPoller(): null {
  const router = useRouter();
  useEffect(() => {
    const interval = setInterval(() => {
      void fetch('/api/pipeline/tick', { method: 'POST' }).then(() => router.refresh());
    }, 10_000);
    return () => clearInterval(interval);
  }, [router]);
  return null;
}
