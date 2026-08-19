import { registerJobHandlers } from '@/lib/jobs/handlers';
import { enqueue } from '@/lib/jobs/queue';
import { runTick } from '@/lib/jobs/runner';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';

/**
 * The weekly paid pass: competitor discovery and competitor re-scans, the
 * only things in v2 that spend Apify credit on a schedule. Weekly rather than
 * daily because a niche does not turn over fast enough to justify seven times
 * the spend.
 *
 * This only enqueues; each child job hits the budget guard itself, so a month
 * that runs dry stops part-way through rather than failing the sweep.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  registerJobHandlers();
  await enqueue('weekly_niche', {}, { dedupe: true });
  await enqueue('run_analysis', { windowDays: 30 }, { dedupe: true });
  const result = await runTick(['weekly_niche'], 8_000);
  return Response.json(result);
}
