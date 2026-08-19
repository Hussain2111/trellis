import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { jobs } from '@/lib/db/schema';
import { env } from '@/lib/env';
import { getAccount } from '@/lib/ingest/upsert';
import { registerJobHandlers } from '@/lib/jobs/handlers';
import { applyScanResult } from '@/lib/jobs/handlers/scan';
import { applyFollowerSnapshot } from '@/lib/jobs/handlers/snapshot-followers';
import { fail, complete as completeJob } from '@/lib/jobs/queue';
import { getScraper } from '@/lib/providers';
import { ApifyScraper, ingestCompletedRun } from '@/lib/providers/scraper/apify';
import { normalizeHashtagItems } from '@/lib/ingest/normalize';

export const dynamic = 'force-dynamic';

interface ApifyWebhookBody {
  eventType?: string;
  resource?: { id?: string; defaultDatasetId?: string; status?: string };
}

/**
 * Apify calls this once an actor run it fired finishes — the "webhook
 * callback" half of every fire-and-return job (scanAccount, scanHashtag).
 * The job type is looked up rather than assumed, since either kind of scan
 * can be waiting on a run at any given moment.
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
        inArray(jobs.type, ['scan_account', 'scan_hashtag', 'snapshot_followers']),
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

  try {
    const scraper = getScraper() as ApifyScraper;
    const run = await scraper.fetchRun(runId);

    if (job.type === 'scan_hashtag') {
      const checkpoint = job.checkpoint as { runId: string; hashtag: string };
      if (!run.succeeded) {
        await fail(job, new Error(`actor finished ${run.status}`), true);
        return Response.json({ ok: false, note: `run ${run.status}` });
      }
      const results = normalizeHashtagItems(run.items);
      await db()
        .update(jobs)
        .set({ checkpoint: { hashtag: checkpoint.hashtag, results } })
        .where(eq(jobs.id, job.id));
      await completeJob(job.id);
      return Response.json({ ok: true, hashtagPosts: results.length });
    }

    if (job.type === 'snapshot_followers') {
      const checkpoint = job.checkpoint as { runId: string; accountId: number; limit: number };
      if (!run.succeeded) {
        await fail(job, new Error(`actor finished ${run.status}`), true);
        return Response.json({ ok: false, note: `run ${run.status}` });
      }
      const result = await applyFollowerSnapshot(checkpoint.accountId, run.items, checkpoint.limit);
      await completeJob(job.id);
      return Response.json({ ok: true, followers: result.count, complete: result.complete });
    }

    const checkpoint = job.checkpoint as { runId: string; limit: number; stopAt: string[] };
    const payload = job.payload as { accountId: number };
    const account = await getAccount(payload.accountId);
    if (!account) throw new Error(`account ${payload.accountId} no longer exists`);

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
