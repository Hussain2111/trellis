'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/primitives';

/** Pokes the job queue every 20s while the calendar is open, so a due post
 * can publish without waiting for the once-a-day cron sweep. */
export function CalendarTickPoller(): null {
  const router = useRouter();
  useEffect(() => {
    const interval = setInterval(() => {
      void fetch('/api/calendar/tick', { method: 'POST' }).then(() => router.refresh());
    }, 20_000);
    return () => clearInterval(interval);
  }, [router]);
  return null;
}

export function UnscheduleButton({ scheduleId }: { scheduleId: number }): React.JSX.Element {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function onClick(): Promise<void> {
    setLoading(true);
    await fetch(`/api/schedule/${scheduleId}`, { method: 'DELETE' });
    router.refresh();
    setLoading(false);
  }

  return (
    <Button size="sm" variant="ghost" onClick={() => void onClick()} disabled={loading}>
      unschedule
    </Button>
  );
}

export function MarkPostedButton({ scheduleId }: { scheduleId: number }): React.JSX.Element {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function onClick(): Promise<void> {
    setLoading(true);
    await fetch(`/api/schedule/${scheduleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark_posted' }),
    });
    router.refresh();
    setLoading(false);
  }

  return (
    <Button size="sm" variant="default" onClick={() => void onClick()} disabled={loading}>
      mark posted
    </Button>
  );
}
