import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { jobs } from '@/lib/db/schema';
import { env } from '@/lib/env';
import { getAccount } from '@/lib/ingest/upsert';
import { registerJobHandlers } from '@/lib/jobs/handlers';
import { applyScanResult } from '@/lib/jobs/handlers/scan';
import { fail, complete as completeJob } from '@/lib/jobs/queue';
import { ApifyScraper } from '@/lib/providers/scraper/apify';
import { getScraper } from '@/lib/providers';
import { ingestCompletedRun } from '@/lib/providers/scraper/apify';

export const dynamic = 'force-dynamic';

interface ApifyWebhookBody {
  eventType?: string;
  resource?: { id?: string; defaultDatasetId?: string; status?: string };
}

/**
 * Apify calls this once the actor run it fired in `scanAccount` finishes.
 * This is the "webhook callback" half of the fire-and-return scan job — see
 * lib/jobs/handlers/scan.ts.
 */
export async function POST(request: Request): Promise<Response> {
  registerJobHandlers();

  const secret = env().APIFY_WEBHOOK_SECRET;
  if (secret) {
    const provided = new URL(request.url).searchParams.get('secret');
    if (provided !== secret) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  let body: ApifyWebhookBody;
  try {
    body = (await request.json()) as ApifyWebhookBody;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const runId = body.resource?.id;
  if (!runId) {
    return Response.json({ error: 'no resource.id in payload' }, { status: 400 });
  }

  const [job] = await db()
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.type, 'scan_account'),
        eq(jobs.status, 'waiting'),
        sql`${jobs.checkpoint}->>'runId' = ${runId}`,
      ),
    )
    .limit(1);

  if (!job) {
    // Unrelated run, a retry of a webhook we already processed, or a run we
    // never started. Acknowledge anyway — Apify retries on non-2xx.
    return Response.json({ ok: true, note: 'no matching waiting job' });
  }

  const checkpoint = job.checkpoint as {
    runId: string;
    limit: number;
    stopAt: string[];
  };
  const payload = job.payload as { accountId: number };

  try {
    const account = await getAccount(payload.accountId);
    if (!account) throw new Error(`account ${payload.accountId} no longer exists`);

    const scraper = getScraper() as ApifyScraper;
    const run = await scraper.fetchRun(runId);
    const result = await ingestCompletedRun(
      account.handle,
      run,
      checkpoint.limit,
      new Set(checkpoint.stopAt),
    );

    await applyScanResult(account.id, result.profile, result.posts, result.complete, result.note);

    if (result.complete) {
      await completeJob(job.id);
    } else {
      await fail(job, new Error(result.note), true);
    }

    return Response.json({ ok: true, postsIngested: result.posts.length });
  } catch (error) {
    await fail(job, error);
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
