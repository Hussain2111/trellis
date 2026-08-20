import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, analyses, calendarEntries, jobs, runs } from '../lib/db/schema';
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
  createEntry,
  deleteEntry,
  entryState,
  listEntries,
  markPosted,
  markScheduleFailed,
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
  await db().delete(calendarEntries);
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
  function entry(
    overrides: Partial<Parameters<typeof createEntry>[0]> = {},
  ): Parameters<typeof createEntry>[0] {
    return {
      scheduledFor: new Date(Date.now() + 3_600_000),
      format: 'image',
      title: 'A post',
      caption: 'cap',
      hashtags: [],
      mediaUrls: ['https://example.com/a.png'],
      ...overrides,
    };
  }

  it('creates, lists, deletes, and marks an entry posted', async () => {
    const id = await createEntry(entry());
    expect((await listEntries()).map((r) => r.id)).toContain(id);

    await markPosted(id);
    const [row] = await db().select().from(calendarEntries).where(eq(calendarEntries.id, id));
    expect(row!.status).toBe('published');
    expect(row!.publishedAt).not.toBeNull();

    await deleteEntry(id);
    expect((await listEntries()).map((r) => r.id)).not.toContain(id);
  });

  it('derives due and overdue from the clock rather than storing them', async () => {
    const now = new Date('2026-08-19T12:00:00+03:00');
    const planned = { status: 'planned' as const, attempts: 0, lastError: null };

    // Later today, Riyadh time — not yet due.
    expect(
      entryState({ ...planned, scheduledFor: new Date('2026-08-19T18:00:00+03:00') } as never, now),
    ).toBe('planned');

    // Earlier today — due, but the day has not rolled over.
    expect(
      entryState({ ...planned, scheduledFor: new Date('2026-08-19T09:00:00+03:00') } as never, now),
    ).toBe('due');

    // Yesterday, Riyadh time — missed.
    expect(
      entryState({ ...planned, scheduledFor: new Date('2026-08-18T23:00:00+03:00') } as never, now),
    ).toBe('overdue');
  });

  it('claimDueForPublish only claims planned rows that are actually due, atomically', async () => {
    const dueId = await createEntry(entry({ scheduledFor: new Date(Date.now() - 60_000) }));
    const futureId = await createEntry(entry({ scheduledFor: new Date(Date.now() + 3_600_000) }));

    const claimed = await claimDueForPublish();
    expect(claimed.map((c) => c.id)).toEqual([dueId]);
    expect(claimed.map((c) => c.id)).not.toContain(futureId);

    const [row] = await db().select().from(calendarEntries).where(eq(calendarEntries.id, dueId));
    expect(row!.status).toBe('claimed');

    // A second claim finds nothing — the row is no longer 'planned'.
    expect(await claimDueForPublish()).toEqual([]);
  });

  it('markScheduleFailed backs off on a transient error and fails permanently on a permanent one', async () => {
    const transientId = await createEntry(entry({ scheduledFor: new Date(Date.now() - 60_000) }));
    await markScheduleFailed(transientId, 'rate limited', false);
    let [row] = await db()
      .select()
      .from(calendarEntries)
      .where(eq(calendarEntries.id, transientId));
    expect(row!.status).toBe('planned');
    expect(row!.attempts).toBe(1);
    expect(row!.scheduledFor.getTime()).toBeGreaterThan(Date.now());

    const permanentId = await createEntry(entry({ scheduledFor: new Date(Date.now() - 60_000) }));
    await markScheduleFailed(permanentId, 'bad request', true);
    [row] = await db().select().from(calendarEntries).where(eq(calendarEntries.id, permanentId));
    expect(row!.status).toBe('failed');
  });
});

describe('publish_due job handler', () => {
  async function seedDueEntry(format: 'image' | 'carousel' | 'reel', mediaCount: number) {
    const self = await upsertAccount({ handle: 'jobself', role: 'self' });
    const id = await createEntry({
      scheduledFor: new Date(Date.now() - 60_000),
      format,
      title: 'A post',
      caption: 'cap',
      hashtags: [],
      mediaUrls: Array.from(
        { length: mediaCount },
        (_, i) => `https://example.com/slide-${i + 1}.png`,
      ),
    });
    return { self, entryId: id };
  }

  it('leaves due rows untouched when ENABLE_IG_PUBLISHING is false (the default)', async () => {
    __setEnvForTests(baseEnv({ ENABLE_IG_PUBLISHING: false }));
    const { entryId } = await seedDueEntry('image', 1);
    let fetchCalled = false;
    __setGraphFetchForTests(async () => {
      fetchCalled = true;
      return jsonResponse({});
    });

    const jobId = await enqueue('publish_due', {});
    await runTick(['publish_due'], 5_000);
    expect((await getJob(jobId!))?.status).toBe('done');
    expect(fetchCalled).toBe(false);

    const [row] = await db().select().from(calendarEntries).where(eq(calendarEntries.id, entryId));
    expect(row!.status).toBe('planned');
  });

  it('fails permanently when publishing is enabled but no token is configured', async () => {
    __setEnvForTests(
      baseEnv({ ENABLE_IG_PUBLISHING: true, IG_USER_ID: undefined, IG_ACCESS_TOKEN: undefined }),
    );
    await seedDueEntry('image', 1);

    const jobId = await enqueue('publish_due', {});
    await runTick(['publish_due'], 5_000);
    const job = await getJob(jobId!);
    expect(job?.status).toBe('failed');
    expect(job?.lastError).toMatch(/IG_USER_ID/);
  });

  it('publishes a single-image entry as one container and marks it published', async () => {
    __setEnvForTests(
      baseEnv({ ENABLE_IG_PUBLISHING: true, IG_USER_ID: 'IGU', IG_ACCESS_TOKEN: 'TOK' }),
    );
    const { entryId } = await seedDueEntry('image', 2);

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

    const [row] = await db().select().from(calendarEntries).where(eq(calendarEntries.id, entryId));
    expect(row!.status).toBe('published');
    expect(row!.igMediaId).toBe('media-1');

    // A non-carousel entry creates one container even with several media URLs.
    expect(
      urlsHit.filter((u) => u.includes('/IGU/media') && !u.includes('media_publish')),
    ).toHaveLength(1);
  });

  it('publishes a carousel entry as a parent container with one child per media URL', async () => {
    __setEnvForTests(
      baseEnv({ ENABLE_IG_PUBLISHING: true, IG_USER_ID: 'IGU', IG_ACCESS_TOKEN: 'TOK' }),
    );
    const { entryId } = await seedDueEntry('carousel', 3);

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

    // 3 children + 1 parent container = 4 /media calls.
    expect(mediaCalls).toBe(4);
    const [row] = await db().select().from(calendarEntries).where(eq(calendarEntries.id, entryId));
    expect(row!.status).toBe('published');
  });

  it('marks the entry permanently failed, not retried, when it carries no media URLs', async () => {
    __setEnvForTests(
      baseEnv({ ENABLE_IG_PUBLISHING: true, IG_USER_ID: 'IGU', IG_ACCESS_TOKEN: 'TOK' }),
    );
    const { entryId } = await seedDueEntry('reel', 0);
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

    const [row] = await db().select().from(calendarEntries).where(eq(calendarEntries.id, entryId));
    expect(row!.status).toBe('failed');
    expect(row!.lastError).toMatch(/no media URLs/);
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
