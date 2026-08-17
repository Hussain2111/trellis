import { registerJobHandlers } from '@/lib/jobs/handlers';
import { enqueue } from '@/lib/jobs/queue';
import { runTick } from '@/lib/jobs/runner';

export const dynamic = 'force-dynamic';

/**
 * Unauthenticated, like every other route in this single-user app (see
 * AGENTS.md — no login of any kind) — unlike /api/cron/publish, which is
 * gated behind CRON_SECRET specifically because it's the endpoint Vercel's
 * own cron caller hits. The calendar page pokes this one instead while
 * it's open, the same "dashboard drives the queue forward" pattern the
 * scan flow already uses, so a due post can go out without waiting for
 * the next daily cron tick.
 */
export async function POST(): Promise<Response> {
  registerJobHandlers();
  await enqueue('publish_due', {}, { dedupe: true });
  const result = await runTick(['publish_due'], 8_000);
  return Response.json(result);
}
