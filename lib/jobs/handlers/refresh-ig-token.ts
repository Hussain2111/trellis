import { env } from '../../env';
import { inspectToken } from '../../publish/graph';
import { recordRun } from '../../runs/log';
import type { JobContext } from '../types';

/**
 * Long-lived Graph API tokens last ~60 days. There's no local-desktop
 * notification channel in a serverless deployment, so "warn the user" here
 * means "leave a loud, findable trail in `runs`" — the same ledger every
 * other provider call already writes to, surfaced later by the settings UI.
 */
export async function refreshIgToken(ctx: JobContext<'refresh_ig_token'>): Promise<void> {
  const e = env();
  if (!e.ENABLE_IG_PUBLISHING || !e.IG_ACCESS_TOKEN) {
    await ctx.save({ progress: 1, label: 'publishing disabled — nothing to refresh' });
    return;
  }

  const info = await inspectToken(e.IG_ACCESS_TOKEN);
  if (!info.valid) {
    await recordRun({
      provider: 'instagram-graph',
      operation: 'token_check',
      status: 'error',
      costEstimate: 0,
      error: `token invalid: ${info.detail}`,
    });
    await ctx.save({ progress: 1, label: `token invalid: ${info.detail}` });
    return;
  }

  await recordRun({
    provider: 'instagram-graph',
    operation: 'token_check',
    status: 'ok',
    costEstimate: 0,
    meta: { daysRemaining: info.daysRemaining, expiringSoon: (info.daysRemaining ?? 99) <= 7 },
  });
  await ctx.save({ progress: 1, label: `token ${info.detail}` });
}
