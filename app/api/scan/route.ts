import { z } from 'zod';
import { upsertAccount } from '@/lib/ingest/upsert';
import { registerJobHandlers } from '@/lib/jobs/handlers';
import { enqueue } from '@/lib/jobs/queue';
import { runTick } from '@/lib/jobs/runner';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  handle: z.string().min(1),
});

/**
 * The one-field input from the spec: an Instagram handle, nothing else.
 * Triggers a scan of the account's last 100 posts. Fixture/fake scans finish
 * within this request; a live scan fires the Apify actor and returns —
 * `/api/webhooks/apify` finishes it later.
 */
export async function POST(request: Request): Promise<Response> {
  registerJobHandlers();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid body' },
      { status: 400 },
    );
  }

  const account = await upsertAccount({ handle: parsed.data.handle, role: 'self' });
  const jobId = await enqueue(
    'scan_account',
    { accountId: account.id, limit: 100 },
    { dedupe: true },
  );

  if (jobId !== null) {
    await runTick(['scan_account'], 8_000);
  }

  return Response.json({ accountId: account.id, jobId });
}
