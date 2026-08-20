'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { tickPipeline } from '@/app/actions/tick';

/**
 * Drives the whole job chain forward while the dashboard is open. Nothing
 * else advances chained job types promptly: Vercel Hobby cron fires once a
 * day, and the GitHub Actions schedule runs every 10 minutes, so without this
 * a scan's follow-on jobs would visibly stall while the user watches.
 */
export function PipelineTickPoller(): null {
  const router = useRouter();
  useEffect(() => {
    const interval = setInterval(() => {
      void tickPipeline().then(() => router.refresh());
    }, 10_000);
    return () => clearInterval(interval);
  }, [router]);
  return null;
}
