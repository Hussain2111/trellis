'use server';

import { registerJobHandlers } from '@/lib/jobs/handlers';
import { enqueue } from '@/lib/jobs/queue';
import { runTick } from '@/lib/jobs/runner';

/**
 * The browser-side half of "the dashboard drives the queue forward".
 *
 * These used to be plain unauthenticated route handlers (`/api/pipeline/tick`,
 * `/api/calendar/tick`), which meant anyone who knew the URL could spin the
 * job queue on demand. Server Actions replace them: same behaviour for an
 * open tab, no publicly documented endpoint, and no shared secret shipped to
 * the browser. The scheduled path is separate — GitHub Actions calls
 * `/api/jobs/tick` with `CRON_SECRET`.
 */

export async function tickPipeline(): Promise<{ processed: number; reaped: number }> {
  registerJobHandlers();
  return runTick(undefined, 8_000);
}

export async function tickPublish(): Promise<{ processed: number; reaped: number }> {
  registerJobHandlers();
  await enqueue('publish_due', {}, { dedupe: true });
  return runTick(['publish_due'], 8_000);
}
