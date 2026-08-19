import { z } from 'zod';
import { env } from '@/lib/env';
import { estimateCost } from '@/lib/ingest/budget';
import { getAccount, removeAccount } from '@/lib/ingest/upsert';
import { registerJobHandlers } from '@/lib/jobs/handlers';
import { enqueue } from '@/lib/jobs/queue';
import { runTick } from '@/lib/jobs/runner';

export const dynamic = 'force-dynamic';

const postSchema = z.object({
  action: z.literal('scan'),
  limit: z.number().int().positive().max(200).default(20),
});

/** Re-scan one competitor on demand, rather than waiting for the weekly pass. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const account = await getAccount(Number(id));
  if (!account) return Response.json({ error: 'No such account.' }, { status: 404 });
  if (account.role !== 'competitor') {
    return Response.json(
      { error: 'Only competitors are scraped. Your own data comes from the Graph API.' },
      { status: 400 },
    );
  }

  const parsed = postSchema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: 'invalid body' }, { status: 400 });

  const e = env();
  const estimate = await estimateCost(parsed.data.limit, e.APIFY_MONTHLY_CREDIT_USD);
  if (!estimate.affordable) {
    return Response.json({ error: estimate.note }, { status: 402 });
  }

  registerJobHandlers();
  const jobId = await enqueue(
    'scan_account',
    { accountId: account.id, limit: parsed.data.limit },
    { dedupe: true },
  );
  await runTick(['scan_account'], 5_000);
  return Response.json({ jobId, note: estimate.note });
}

/** Removing a competitor cascades its posts — that is the point, not a side effect. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  await removeAccount(Number(id));
  return Response.json({ ok: true });
}
