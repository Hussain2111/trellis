import { registerJobHandlers } from '@/lib/jobs/handlers';
import { enqueue } from '@/lib/jobs/queue';
import { runTick } from '@/lib/jobs/runner';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';

/**
 * Long-lived Graph tokens last ~60 days. Everything the account's own data
 * depends on now runs through that one token, so letting it lapse silently
 * stops the daily sync, the insights, and the comments all at once — this
 * checks it well ahead of the deadline and leaves a trail in `runs`.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  registerJobHandlers();
  await enqueue('refresh_ig_token', {}, { dedupe: true });
  const result = await runTick(['refresh_ig_token'], 8_000);
  return Response.json(result);
}
