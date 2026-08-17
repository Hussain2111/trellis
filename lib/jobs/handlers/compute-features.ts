import { persistFeatures } from '../../analysis/features';
import { getAccount, listAccounts } from '../../ingest/upsert';
import { enqueue } from '../queue';
import type { JobContext } from '../types';

/** Deterministic — free, exact, no model involved. Chains hook classification, which isn't. */
const OUTLIER_MULTIPLIER = 2.5;

export async function computeFeatures(ctx: JobContext<'compute_features'>): Promise<void> {
  const accounts =
    ctx.payload.accountId !== undefined
      ? [await getAccount(ctx.payload.accountId)].filter((a) => a !== null)
      : await listAccounts();

  let total = 0;
  for (const account of accounts) {
    total += await persistFeatures(account.id, account.followers, OUTLIER_MULTIPLIER);
  }

  await ctx.save({ progress: 1, label: `${total} post(s) featurized` });

  await enqueue('classify_hooks', { accountId: ctx.payload.accountId }, { dedupe: true });
}
