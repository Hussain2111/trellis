import { registerJobHandlers } from '@/lib/jobs/handlers';
import { runTick } from '@/lib/jobs/runner';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';

/**
 * Advances the job queue by one time-boxed tick. This is the "short
 * invocation" half of the fire-and-return pattern for everything that isn't
 * itself waiting on a webhook — the dashboard polls this while a job is
 * active, and it's also safe to hang off a cron schedule.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  registerJobHandlers();
  const result = await runTick(undefined, 8_000);
  return Response.json(result);
}
