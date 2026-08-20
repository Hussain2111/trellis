import { z } from 'zod';
import { env } from '@/lib/env';
import { estimateCost } from '@/lib/ingest/budget';
import { listAccounts, upsertAccount } from '@/lib/ingest/upsert';
import { registerJobHandlers } from '@/lib/jobs/handlers';
import { enqueue } from '@/lib/jobs/queue';
import { runTick } from '@/lib/jobs/runner';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  handle: z
    .string()
    .min(1)
    .transform((h) => h.replace(/^@/, '').trim().toLowerCase()),
  limit: z.number().int().positive().max(200).default(20),
});

export async function GET(): Promise<Response> {
  return Response.json({ competitors: await listAccounts('competitor') });
}

/**
 * Adds a competitor by handle and queues its first scan.
 *
 * Discovery finds accounts that dominate your hashtags, which is not the same
 * set as the accounts you actually consider rivals. This is the manual
 * override for that gap.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid body' },
      { status: 400 },
    );
  }
  const { handle, limit } = parsed.data;

  const existing = await listAccounts();
  const clash = existing.find((a) => a.handle === handle);
  if (clash?.role === 'self') {
    return Response.json(
      { error: `@${handle} is your own account — it cannot also be a competitor.` },
      { status: 400 },
    );
  }

  const e = env();
  const estimate = await estimateCost(limit, e.APIFY_MONTHLY_CREDIT_USD);
  if (!estimate.affordable) {
    return Response.json({ error: estimate.note }, { status: 402 });
  }

  const account = await upsertAccount({ handle, role: 'competitor' });
  registerJobHandlers();
  const jobId = await enqueue('scan_account', { accountId: account.id, limit }, { dedupe: true });
  await runTick(['scan_account'], 5_000);

  return Response.json({ id: account.id, handle: account.handle, jobId, note: estimate.note });
}
