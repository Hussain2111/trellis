import { z } from 'zod';
import { env } from '@/lib/env';
import { selfAccount, upsertAccount } from '@/lib/ingest/upsert';
import { registerJobHandlers } from '@/lib/jobs/handlers';
import { enqueue } from '@/lib/jobs/queue';
import { runTick } from '@/lib/jobs/runner';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  handle: z.string().min(1),
});

/**
 * Registers the managed account and pulls its data from the Graph API.
 *
 * In v1 this fired an Apify scrape. It no longer can: the account's own posts,
 * insights and comments are free through the Graph API, and `scanAccount`
 * refuses `role: 'self'` outright. The handle is still asked for because it is
 * what the rest of the UI labels things with — but the data comes from
 * IG_USER_ID / IG_ACCESS_TOKEN, so a handle alone is not enough any more, and
 * saying so here beats a job that fails silently ten seconds later.
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

  const e = env();
  if (!e.IG_USER_ID || !e.IG_ACCESS_TOKEN) {
    return Response.json(
      {
        error:
          'IG_USER_ID and IG_ACCESS_TOKEN are not set. Your own account’s data comes from the Instagram Graph API now, not from scraping — see docs/instagram-setup.md.',
      },
      { status: 400 },
    );
  }

  const existing = await selfAccount();
  if (existing && existing.handle !== parsed.data.handle.replace(/^@/, '').trim().toLowerCase()) {
    return Response.json(
      {
        error: `@${existing.handle} is already the managed account. Only one account is managed at a time; remove it from the database to switch.`,
      },
      { status: 400 },
    );
  }

  const account = await upsertAccount({ handle: parsed.data.handle, role: 'self' });
  const jobId = await enqueue('sync_own_account', {}, { dedupe: true });

  if (jobId !== null) {
    await runTick(['sync_own_account'], 8_000);
  }

  return Response.json({ accountId: account.id, jobId });
}
