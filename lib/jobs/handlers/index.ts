import { registerHandler } from '../registry';
import { discoverCompetitors } from './discover-competitors';
import { scanAccount } from './scan';
import { scanHashtag } from './scan-hashtag';

/**
 * Registers every job handler that exists so far. Import this once, for its
 * side effect, from any entry point that might run a job tick (API routes,
 * webhooks, the keepalive cron). Handlers are added here stage by stage.
 */
let registered = false;

export function registerJobHandlers(): void {
  if (registered) return;
  registered = true;
  registerHandler('scan_account', scanAccount);
  registerHandler('scan_hashtag', scanHashtag);
  registerHandler('discover_competitors', discoverCompetitors);
}
