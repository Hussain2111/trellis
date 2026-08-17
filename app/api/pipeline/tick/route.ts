import { registerJobHandlers } from '@/lib/jobs/handlers';
import { runTick } from '@/lib/jobs/runner';

export const dynamic = 'force-dynamic';

/**
 * Unauthenticated, like /api/calendar/tick — advances the whole job queue
 * (compute_features, classify_hooks, run_analysis, build_voice_profile,
 * generate_drafts, render_slides, publish_due, ...), not just scan_account.
 *
 * A scan only synchronously ticks 'scan_account' itself (see /api/scan and
 * the webhook receiver); everything a scan chains after that — features,
 * hooks, analysis, voice, drafts — otherwise has no automatic trigger in
 * production, since Vercel Hobby cron only runs once a day. The dashboard
 * polls this while open so the pipeline actually finishes in the time a
 * user is willing to sit and watch, not "sometime in the next 24 hours."
 */
export async function POST(): Promise<Response> {
  registerJobHandlers();
  const result = await runTick(undefined, 8_000);
  return Response.json(result);
}
