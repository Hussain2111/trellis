import { registerJobHandlers } from '@/lib/jobs/handlers';
import { enqueue } from '@/lib/jobs/queue';
import { runTick } from '@/lib/jobs/runner';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';

/**
 * Vercel Hobby cron jobs run at most once a day, so this is the outer safety
 * net for scheduled posts, not the primary path — the calendar page (Stage
 * 21) also pokes /api/jobs/tick while it's open, the same "dashboard polls
 * while something's active" pattern the scan flow already uses, which is
 * what actually gets a post out close to its scheduled time. A day of worst-
 * case slack from this cron alone is the accepted cost of staying at $0.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  registerJobHandlers();
  await enqueue('publish_due', {}, { dedupe: true });
  await enqueue('refresh_ig_token', {}, { dedupe: true });
  const result = await runTick(['publish_due', 'refresh_ig_token'], 8_000);
  return Response.json(result);
}
