import { registerHandler } from '../registry';
import { classifyHooks } from './classify-hooks';
import { computeFeatures } from './compute-features';
import { discoverCompetitors } from './discover-competitors';
import { generateInsights } from './generate-insights';
import { publishDue } from './publish-due';
import { refreshIgToken } from './refresh-ig-token';
import { runAnalysis } from './run-analysis';
import { scanAccount } from './scan';
import { scanHashtag } from './scan-hashtag';
import { snapshotFollowers } from './snapshot-followers';
import { syncOwnAccount } from './sync-own-account';
import { weeklyNiche } from './weekly-niche';

/**
 * Registers every job handler that exists. Import this once, for its side
 * effect, from any entry point that might run a job tick (API routes,
 * webhooks, the cron routes).
 */
let registered = false;

export function registerJobHandlers(): void {
  if (registered) return;
  registered = true;
  registerHandler('scan_account', scanAccount);
  registerHandler('scan_hashtag', scanHashtag);
  registerHandler('discover_competitors', discoverCompetitors);
  registerHandler('compute_features', computeFeatures);
  registerHandler('classify_hooks', classifyHooks);
  registerHandler('run_analysis', runAnalysis);
  registerHandler('sync_own_account', syncOwnAccount);
  registerHandler('weekly_niche', weeklyNiche);
  registerHandler('generate_insights', generateInsights);
  registerHandler('snapshot_followers', snapshotFollowers);
  registerHandler('publish_due', publishDue);
  registerHandler('refresh_ig_token', refreshIgToken);
}
