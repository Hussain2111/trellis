import { env } from '@/lib/env';
import { getApifySpend, estimateCost } from '@/lib/ingest/budget';
import { selfAccount } from '@/lib/ingest/upsert';
import { registerJobHandlers } from '@/lib/jobs/handlers';
import { enqueue } from '@/lib/jobs/queue';
import { runTick } from '@/lib/jobs/runner';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 2000;

/**
 * The only place in v2 that spends Apify credit on the managed account, and
 * the only one behind a button rather than a schedule. Naming who unfollowed
 * needs a follower list, and the Graph API does not expose one at any price.
 *
 * GET reports what it would cost so the UI can say so before the click; POST
 * actually starts it.
 */
export async function GET(): Promise<Response> {
  const e = env();
  const estimate = await estimateCost(DEFAULT_LIMIT, e.APIFY_MONTHLY_CREDIT_USD);
  const spend = await getApifySpend(e.APIFY_MONTHLY_CREDIT_USD);
  return Response.json({ estimate, spend, scrapeMode: e.SCRAPE_MODE });
}

export async function POST(): Promise<Response> {
  const self = await selfAccount();
  if (!self) {
    return Response.json({ error: 'No account is marked as yours yet.' }, { status: 400 });
  }

  const e = env();
  if (e.SCRAPE_MODE !== 'live') {
    return Response.json(
      {
        error: `SCRAPE_MODE is ${e.SCRAPE_MODE}. A follower snapshot needs a real scrape — there is no fixture that could stand in for one honestly.`,
      },
      { status: 400 },
    );
  }

  const estimate = await estimateCost(DEFAULT_LIMIT, e.APIFY_MONTHLY_CREDIT_USD);
  if (!estimate.affordable) {
    return Response.json({ error: estimate.note }, { status: 402 });
  }

  registerJobHandlers();
  const jobId = await enqueue(
    'snapshot_followers',
    { accountId: self.id, limit: DEFAULT_LIMIT },
    { dedupe: true },
  );
  await runTick(['snapshot_followers'], 5_000);
  return Response.json({ jobId, estimate });
}
