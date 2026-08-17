import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, analyses, draftAssets, drafts, jobs, runs, schedule } from '../lib/db/schema';
import { __setEnvForTests, envSchema } from '../lib/env';
import { registerJobHandlers } from '../lib/jobs/handlers';
import { enqueue, getJob } from '../lib/jobs/queue';
import { runTick } from '../lib/jobs/runner';
import { upsertAccount } from '../lib/ingest/upsert';
import {
  GraphError,
  __setGraphFetchForTests,
  createContainer,
  inspectToken,
  publishContainer,
  publishingLimit,
  waitForContainer,
} from '../lib/publish/graph';
import {
  claimDueForPublish,
  markPosted,
  markScheduleFailed,
  scheduleDraft,
  scheduledRows,
  unschedule,
} from '../lib/publish/schedule';

registerJobHandlers();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(async () => {
  __setGraphFetchForTests(null);
  __setEnvForTests(null);
  await db().delete(jobs);
  await db().delete(schedule);
  await db().delete(draftAssets);
  await db().delete(drafts);
  await db().delete(analyses);
  await db().delete(runs);
  await db().delete(accounts);
});

afterAll(async () => {
  await closeDb();
});

function baseEnv(overrides: Partial<Parameters<typeof envSchema.parse>[0]> = {}) {
  return envSchema.parse({
    DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/trellis',
    ...overrides,
  });
}

describe('lib/publish/graph', () => {
  it('creates a container and publishes it, posting the expected form fields', async () => {
    const calls: { url: string; body?: string }[] = [];
    __setGraphFetchForTests(async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? String(init.body) : undefined });
      if (url.includes('/media_publish')) return jsonResponse({ id: 'media-1' });
      return jsonResponse({ id: 'container-1' });
    });

    const containerId = await createContainer({
      igUserId: 'IGU',
      token: 'TOK',
      caption: 'hello',
      imageUrl: 'https://example.com/a.png',
    });
    expect(containerId).toBe('container-1');
    expect(calls[0]!.url).toContain('/IGU/media');
    expect(calls[0]!.body).toContain('image_url=');
    expect(calls[0]!.body).toContain('access_token=TOK');

    const mediaId = await publishContainer('IGU', containerId, 'TOK');
    expect(mediaId).toBe('media-1');
    expect(calls[1]!.body).toContain('creation_id=container-1');
  });

  it('waitForContainer resolves once status_code is FINISHED', async () => {
    let n = 0;
    __setGraphFetchForTests(async () => {
      n++;
      return jsonResponse({ status_code: n < 2 ? 'IN_PROGRESS' : 'FINISHED' });
    });
    await expect(
      waitForContainer('c1', 'TOK', { intervalMs: 1, timeoutMs: 5_000 }),
    ).resolves.toBeUndefined();
    expect(n).toBe(2);
  });

  it('waitForContainer throws on ERROR status', async () => {
    __setGraphFetchForTests(async () =>
      jsonResponse({ status_code: 'ERROR', status: 'bad media' }),
    );
    await expect(waitForContainer('c1', 'TOK', { intervalMs: 1 })).rejects.toThrow(/ERROR/);
  });

  it('waitForContainer times out if never FINISHED', async () => {
    __setGraphFetchForTests(async () => jsonResponse({ status_code: 'IN_PROGRESS' }));
    await expect(waitForContainer('c1', 'TOK', { intervalMs: 1, timeoutMs: 3 })).rejects.toThrow(
      /did not finish/,
    );
  });

  it('classifies a 400 as permanent and a 429 as not', async () => {
    __setGraphFetchForTests(async () => jsonResponse({ error: { message: 'bad request' } }, 400));
    await expect(createContainer({ igUserId: 'IGU', token: 'TOK' })).rejects.toMatchObject({
      permanent: true,
      status: 400,
    } satisfies Partial<GraphError>);

    __setGraphFetchForTests(async () => jsonResponse({ error: { message: 'rate limited' } }, 429));
    await expect(createContainer({ igUserId: 'IGU', token: 'TOK' })).rejects.toMatchObject({
      permanent: false,
      status: 429,
    } satisfies Partial<GraphError>);
  });

  it('publishingLimit returns null rather than throwing when the call fails', async () => {
    __setGraphFetchForTests(async () => jsonResponse({ error: { message: 'nope' } }, 500));
    await expect(publishingLimit('IGU', 'TOK')).resolves.toBeNull();
  });

  it('publishingLimit reports usage and cap on success', async () => {
    __setGraphFetchForTests(async () =>
      jsonResponse({ data: [{ quota_usage: 3, config: { quota_total: 25 } }] }),
    );
    await expect(publishingLimit('IGU', 'TOK')).resolves.toEqual({ used: 3, cap: 25 });
  });

  it('inspectToken reports validity and days remaining', async () => {
    const inOneWeek = Math.floor(Date.now() / 1000) + 7 * 86_400;
    __setGraphFetchForTests(async () =>
      jsonResponse({ data: { is_valid: true, expires_at: inOneWeek } }),
    );
    const info = await inspectToken('TOK');
    expect(info.valid).toBe(true);
    expect(info.daysRemaining).toBeGreaterThanOrEqual(6);
    expect(info.daysRemaining).toBeLessThanOrEqual(7);
  });

  it('inspectToken degrades to invalid rather than throwing on a network error', async () => {
    __setGraphFetchForTests(async () => {
      throw new Error('network down');
    });
    const info = await inspectToken('TOK');
    expect(info.valid).toBe(false);
    expect(info.detail).toContain('network down');
  });
});

describe('lib/publish/schedule', () => {
  it('schedules, unschedules, and marks a draft posted, always keeping drafts.status in sync', async () => {
    await upsertAccount({ handle: 'scheduleself', role: 'self' });
    const [analysis] = await db()
      .insert(analyses)
      .values({ windowDays: 30, patterns: [], gap: {}, inputsHash: 'x', generatedBy: 'test' })
      .returning({ id: analyses.id });
    const [draft] = await db()
      .insert(drafts)
      .values({
        analysisId: analysis!.id,
        format: 'image',
        title: 'A draft',
        hook: 'h',
        body: { kind: 'image', concept: 'c', image_direction: 'd' },
        caption: 'cap',
        hashtags: [],
        evidence: [],
        generatedBy: 'test',
      })
      .returning({ id: drafts.id });

    const scheduleId = await scheduleDraft(draft!.id, new Date(Date.now() + 3_600_000));
    let [draftRow] = await db().select().from(drafts).where(eq(drafts.id, draft!.id));
    expect(draftRow!.status).toBe('scheduled');

    const rows = await scheduledRows();
    expect(rows.map((r) => r.schedule.id)).toContain(scheduleId);

    await unschedule(scheduleId);
    [draftRow] = await db().select().from(drafts).where(eq(drafts.id, draft!.id));
    expect(draftRow!.status).toBe('draft');
    expect((await scheduledRows()).map((r) => r.schedule.id)).not.toContain(scheduleId);

    const secondId = await scheduleDraft(draft!.id, new Date(Date.now() + 3_600_000));
    await markPosted(secondId);
    const [row] = await db().select().from(schedule).where(eq(schedule.id, secondId));
    expect(row!.status).toBe('published');
    expect(row!.publishedAt).not.toBeNull();
    [draftRow] = await db().select().from(drafts).where(eq(drafts.id, draft!.id));
    expect(draftRow!.status).toBe('published');
  });

  it('claimDueForPublish only claims pending rows that are actually due, atomically', async () => {
    await upsertAccount({ handle: 'scheduleself2', role: 'self' });
    const [analysis] = await db()
      .insert(analyses)
      .values({ windowDays: 30, patterns: [], gap: {}, inputsHash: 'y', generatedBy: 'test' })
      .returning({ id: analyses.id });
    const [draft] = await db()
      .insert(drafts)
      .values({
        analysisId: analysis!.id,
        format: 'image',
        title: 'A draft',
        hook: 'h',
        body: { kind: 'image', concept: 'c', image_direction: 'd' },
        caption: 'cap',
        hashtags: [],
        evidence: [],
        generatedBy: 'test',
      })
      .returning({ id: drafts.id });

    const dueId = await scheduleDraft(draft!.id, new Date(Date.now() - 60_000));
    const futureId = await scheduleDraft(draft!.id, new Date(Date.now() + 3_600_000));

    const claimed = await claimDueForPublish();
    expect(claimed.map((c) => c.id)).toEqual([dueId]);
    expect(claimed.map((c) => c.id)).not.toContain(futureId);

    const [row] = await db().select().from(schedule).where(eq(schedule.id, dueId));
    expect(row!.status).toBe('claimed');

    // A second claim finds nothing — the row is no longer 'pending'.
    expect(await claimDueForPublish()).toEqual([]);
  });

  it('markScheduleFailed backs off on a transient error and fails permanently on a permanent one', async () => {
    await upsertAccount({ handle: 'scheduleself3', role: 'self' });
    const [analysis] = await db()
      .insert(analyses)
      .values({ windowDays: 30, patterns: [], gap: {}, inputsHash: 'z', generatedBy: 'test' })
      .returning({ id: analyses.id });
    const [draft] = await db()
      .insert(drafts)
      .values({
        analysisId: analysis!.id,
        format: 'image',
        title: 'A draft',
        hook: 'h',
        body: { kind: 'image', concept: 'c', image_direction: 'd' },
        caption: 'cap',
        hashtags: [],
        evidence: [],
        generatedBy: 'test',
      })
      .returning({ id: drafts.id });

    const transientId = await scheduleDraft(draft!.id, new Date(Date.now() - 60_000));
    await markScheduleFailed(transientId, 'rate limited', false);
    let [row] = await db().select().from(schedule).where(eq(schedule.id, transientId));
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(1);
    expect(row!.scheduledFor.getTime()).toBeGreaterThan(Date.now());

    const permanentId = await scheduleDraft(draft!.id, new Date(Date.now() - 60_000));
    await markScheduleFailed(permanentId, 'bad request', true);
    [row] = await db().select().from(schedule).where(eq(schedule.id, permanentId));
    expect(row!.status).toBe('failed');
  });
});

describe('publish_due job handler', () => {
  async function seedScheduledDraft(format: 'image' | 'carousel' | 'reel', slideCount: number) {
    const self = await upsertAccount({ handle: 'jobself', role: 'self' });
    const [analysis] = await db()
      .insert(analyses)
      .values({
        windowDays: 30,
        patterns: [],
        gap: {},
        inputsHash: `h${Math.random()}`,
        generatedBy: 'test',
      })
      .returning({ id: analyses.id });
    const [draft] = await db()
      .insert(drafts)
      .values({
        analysisId: analysis!.id,
        format,
        title: 'A draft',
        hook: 'h',
        body:
          format === 'carousel'
            ? { kind: 'carousel', slides: [{ heading: 'a', body: 'b' }] }
            : format === 'reel'
              ? { kind: 'reel', hook_line: 'h', beats: [] }
              : { kind: 'image', concept: 'c', image_direction: 'd' },
        caption: 'cap',
        hashtags: [],
        evidence: [],
        generatedBy: 'test',
      })
      .returning({ id: drafts.id });

    for (let i = 1; i <= slideCount; i++) {
      await db()
        .insert(draftAssets)
        .values({
          draftId: draft!.id,
          kind: 'slide',
          slideIndex: i,
          publicUrl: `https://example.com/${draft!.id}/slide-${i}.png`,
        });
    }

    const scheduleId = await scheduleDraft(draft!.id, new Date(Date.now() - 60_000));
    return { self, draftId: draft!.id, scheduleId };
  }

  it('leaves due rows untouched when ENABLE_IG_PUBLISHING is false (the default)', async () => {
    __setEnvForTests(baseEnv({ ENABLE_IG_PUBLISHING: false }));
    const { scheduleId } = await seedScheduledDraft('image', 1);
    let fetchCalled = false;
    __setGraphFetchForTests(async () => {
      fetchCalled = true;
      return jsonResponse({});
    });

    const jobId = await enqueue('publish_due', {});
    await runTick(['publish_due'], 5_000);
    expect((await getJob(jobId!))?.status).toBe('done');
    expect(fetchCalled).toBe(false);

    const [row] = await db().select().from(schedule).where(eq(schedule.id, scheduleId));
    expect(row!.status).toBe('pending');
  });

  it('fails permanently when publishing is enabled but no token is configured', async () => {
    __setEnvForTests(
      baseEnv({ ENABLE_IG_PUBLISHING: true, IG_USER_ID: undefined, IG_ACCESS_TOKEN: undefined }),
    );
    await seedScheduledDraft('image', 1);

    const jobId = await enqueue('publish_due', {});
    await runTick(['publish_due'], 5_000);
    const job = await getJob(jobId!);
    expect(job?.status).toBe('failed');
    expect(job?.lastError).toMatch(/IG_USER_ID/);
  });

  it('publishes a single-image draft as one container, and marks the schedule + draft published', async () => {
    __setEnvForTests(
      baseEnv({ ENABLE_IG_PUBLISHING: true, IG_USER_ID: 'IGU', IG_ACCESS_TOKEN: 'TOK' }),
    );
    const { draftId, scheduleId } = await seedScheduledDraft('image', 2);

    const urlsHit: string[] = [];
    __setGraphFetchForTests(async (input) => {
      const url = String(input);
      urlsHit.push(url);
      if (url.includes('content_publishing_limit')) {
        return jsonResponse({ data: [{ quota_usage: 0, config: { quota_total: 25 } }] });
      }
      if (url.includes('/media_publish')) return jsonResponse({ id: 'media-1' });
      if (/\/media\?/.test(url) || url.endsWith('/media'))
        return jsonResponse({ id: 'container-1' });
      return jsonResponse({ status_code: 'FINISHED' });
    });

    const jobId = await enqueue('publish_due', {});
    await runTick(['publish_due'], 5_000);
    expect((await getJob(jobId!))?.status).toBe('done');

    const [scheduleRow] = await db().select().from(schedule).where(eq(schedule.id, scheduleId));
    expect(scheduleRow!.status).toBe('published');
    expect(scheduleRow!.igMediaId).toBe('media-1');

    const [draftRow] = await db().select().from(drafts).where(eq(drafts.id, draftId));
    expect(draftRow!.status).toBe('published');

    // Only a single (non-carousel) container was created — one image_url call, not two children.
    expect(
      urlsHit.filter((u) => u.includes('/IGU/media') && !u.includes('media_publish')),
    ).toHaveLength(1);
  });

  it('publishes a carousel draft as a parent container with children, one per slide', async () => {
    __setEnvForTests(
      baseEnv({ ENABLE_IG_PUBLISHING: true, IG_USER_ID: 'IGU', IG_ACCESS_TOKEN: 'TOK' }),
    );
    const { scheduleId } = await seedScheduledDraft('carousel', 3);

    let mediaCalls = 0;
    __setGraphFetchForTests(async (input) => {
      const url = String(input);
      if (url.includes('content_publishing_limit')) {
        return jsonResponse({ data: [{ quota_usage: 0, config: { quota_total: 25 } }] });
      }
      if (url.includes('/media_publish')) return jsonResponse({ id: 'media-parent' });
      if (url.includes('/IGU/media')) {
        mediaCalls++;
        return jsonResponse({ id: `container-${mediaCalls}` });
      }
      return jsonResponse({ status_code: 'FINISHED' });
    });

    const jobId = await enqueue('publish_due', {});
    await runTick(['publish_due'], 8_000);
    expect((await getJob(jobId!))?.status).toBe('done');

    // 3 slide children + 1 parent container = 4 /media calls.
    expect(mediaCalls).toBe(4);
    const [scheduleRow] = await db().select().from(schedule).where(eq(schedule.id, scheduleId));
    expect(scheduleRow!.status).toBe('published');
  });

  it('marks the schedule row permanently failed, not retried, when there are no rendered assets', async () => {
    __setEnvForTests(
      baseEnv({ ENABLE_IG_PUBLISHING: true, IG_USER_ID: 'IGU', IG_ACCESS_TOKEN: 'TOK' }),
    );
    const { scheduleId } = await seedScheduledDraft('reel', 0);
    __setGraphFetchForTests(async (input) => {
      const url = String(input);
      if (url.includes('content_publishing_limit')) {
        return jsonResponse({ data: [{ quota_usage: 0, config: { quota_total: 25 } }] });
      }
      return jsonResponse({ id: 'x' });
    });

    const jobId = await enqueue('publish_due', {});
    await runTick(['publish_due'], 5_000);
    expect((await getJob(jobId!))?.status).toBe('done'); // the sweep itself succeeds; the row fails

    const [row] = await db().select().from(schedule).where(eq(schedule.id, scheduleId));
    expect(row!.status).toBe('failed');
    expect(row!.lastError).toMatch(/no rendered assets/);
  });
});

describe('refresh_ig_token job handler', () => {
  it('no-ops when publishing is disabled', async () => {
    __setEnvForTests(baseEnv({ ENABLE_IG_PUBLISHING: false }));
    let fetchCalled = false;
    __setGraphFetchForTests(async () => {
      fetchCalled = true;
      return jsonResponse({});
    });
    const jobId = await enqueue('refresh_ig_token', {});
    await runTick(['refresh_ig_token'], 5_000);
    expect((await getJob(jobId!))?.status).toBe('done');
    expect(fetchCalled).toBe(false);
  });

  it('records a run when the token is valid', async () => {
    __setEnvForTests(baseEnv({ ENABLE_IG_PUBLISHING: true, IG_ACCESS_TOKEN: 'TOK' }));
    __setGraphFetchForTests(async () =>
      jsonResponse({
        data: { is_valid: true, expires_at: Math.floor(Date.now() / 1000) + 30 * 86_400 },
      }),
    );
    const jobId = await enqueue('refresh_ig_token', {});
    await runTick(['refresh_ig_token'], 5_000);
    expect((await getJob(jobId!))?.status).toBe('done');

    const [row] = await db().select().from(runs).where(eq(runs.operation, 'token_check'));
    expect(row!.status).toBe('ok');
  });

  it('records an error run when the token is invalid', async () => {
    __setEnvForTests(baseEnv({ ENABLE_IG_PUBLISHING: true, IG_ACCESS_TOKEN: 'TOK' }));
    __setGraphFetchForTests(async () => jsonResponse({ data: { is_valid: false } }));
    const jobId = await enqueue('refresh_ig_token', {});
    await runTick(['refresh_ig_token'], 5_000);
    expect((await getJob(jobId!))?.status).toBe('done');

    const [row] = await db().select().from(runs).where(eq(runs.operation, 'token_check'));
    expect(row!.status).toBe('error');
  });
});
