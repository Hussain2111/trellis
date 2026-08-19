import { registerJobHandlers } from '@/lib/jobs/handlers';
import { enqueue } from '@/lib/jobs/queue';
import { runTick } from '@/lib/jobs/runner';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';

/**
 * The daily free pass: the managed account's own posts, insights, comments
 * and follower count, straight from the Graph API. Nothing here spends Apify
 * credit, which is why it can afford to run every day.
 *
 * Scheduled by GitHub Actions, not Vercel — Hobby cron is capped at one run a
 * day per entry and the two available entries are already spoken for.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  registerJobHandlers();
  await enqueue('sync_own_account', {}, { dedupe: true });
  // Features and hook labels are what the analytics views read; refreshing
  // them here keeps the daily numbers from lagging a week behind the posts.
  await enqueue('compute_features', {}, { dedupe: true });
  const result = await runTick(['sync_own_account', 'compute_features'], 8_000);
  return Response.json(result);
}
