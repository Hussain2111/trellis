import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import {
  accounts,
  calendarEntries,
  followerDaily,
  postComments,
  postInsights,
  posts,
} from '../lib/db/schema';
import { weeklyReport } from '../lib/analytics/weekly';
import { createEntry } from '../lib/publish/schedule';
import { upsertAccount } from '../lib/ingest/upsert';

afterEach(async () => {
  await db().delete(postComments);
  await db().delete(postInsights);
  await db().delete(calendarEntries);
  await db().delete(followerDaily);
  await db().delete(posts);
  await db().delete(accounts);
});

afterAll(async () => {
  await closeDb();
});

// Wednesday 19 Aug 2026, 15:00 Riyadh. That week starts Monday 17 Aug 00:00
// Riyadh, which is 16 Aug 21:00 UTC.
const NOW = new Date('2026-08-19T12:00:00Z');

let n = 0;
async function seedPost(accountId: number, takenAt: Date, reach: number | null, likes = 0) {
  const [row] = await db()
    .insert(posts)
    .values({
      accountId,
      shortcode: `W${++n}`,
      type: 'reel',
      takenAt,
      likes,
      comments: 0,
      source: 'graph',
      raw: {},
    })
    .returning({ id: posts.id });
  if (reach != null) {
    await db().insert(postInsights).values({ postId: row!.id, checkpoint: 'latest', reach });
  }
  return row!.id;
}

const metric = (report: Awaited<ReturnType<typeof weeklyReport>>, label: string) =>
  report.metrics.find((m) => m.label === label)!;

describe('weeklyReport', () => {
  it('bounds the week at Monday 00:00 Riyadh, not Monday 00:00 UTC', async () => {
    const account = await upsertAccount({ handle: 'w1', role: 'self' });
    // 22:00 UTC Sunday = 01:00 Monday Riyadh → belongs to this week.
    await seedPost(account.id, new Date('2026-08-16T22:00:00Z'), 100);
    // 20:00 UTC Sunday = 23:00 Sunday Riyadh → still last week.
    await seedPost(account.id, new Date('2026-08-16T20:00:00Z'), 100);

    const report = await weeklyReport(NOW);
    expect(metric(report, 'Posts published').value).toBe(1);
    expect(metric(report, 'Posts published').previous).toBe(1);
  });

  it('compares against the previous week and reports the difference', async () => {
    const account = await upsertAccount({ handle: 'w2', role: 'self' });
    await seedPost(account.id, new Date('2026-08-18T09:00:00Z'), 300);
    await seedPost(account.id, new Date('2026-08-19T09:00:00Z'), 500);
    await seedPost(account.id, new Date('2026-08-12T09:00:00Z'), 200);

    const report = await weeklyReport(NOW);
    expect(metric(report, 'Posts published').value).toBe(2);
    expect(metric(report, 'Posts published').change).toBe(1);
    expect(metric(report, 'Total reach').value).toBe(800);
    expect(metric(report, 'Total reach').change).toBe(600);
  });

  it('leaves reach null rather than 0 when nothing this week carries insights', async () => {
    const account = await upsertAccount({ handle: 'w3', role: 'self' });
    await seedPost(account.id, new Date('2026-08-18T09:00:00Z'), null, 50);

    const report = await weeklyReport(NOW);
    expect(metric(report, 'Posts published').value).toBe(1);
    expect(metric(report, 'Total reach').value).toBeNull();
    expect(metric(report, 'Total reach').change).toBeNull();
    expect(report.notes.join(' ')).toMatch(/reach/);
  });

  it('needs two daily follower readings before it will report a change', async () => {
    await db().insert(followerDaily).values({ day: '2026-08-18', followerCount: 100 });

    let report = await weeklyReport(NOW);
    expect(metric(report, 'Follower change').value).toBeNull();
    expect(report.notes.join(' ')).toMatch(/two daily readings/);

    await db().insert(followerDaily).values({ day: '2026-08-19', followerCount: 130 });

    report = await weeklyReport(NOW);
    expect(metric(report, 'Follower change').value).toBe(30);
  });

  it('names the best post by reach, falling back to interactions when reach is absent', async () => {
    const account = await upsertAccount({ handle: 'w4', role: 'self' });
    await seedPost(account.id, new Date('2026-08-18T09:00:00Z'), 100);
    await seedPost(account.id, new Date('2026-08-18T10:00:00Z'), 900);

    let report = await weeklyReport(NOW);
    expect(report.topPost!.reach).toBe(900);

    await db().delete(postInsights);
    await seedPost(account.id, new Date('2026-08-18T11:00:00Z'), null, 5000);
    report = await weeklyReport(NOW);
    expect(report.topPost!.interactions).toBe(5000);
  });

  it('counts planned entries against what actually went out', async () => {
    await createEntry({
      scheduledFor: new Date('2026-08-18T09:00:00Z'),
      format: 'image',
      title: 'went out',
      caption: '',
      hashtags: [],
      mediaUrls: [],
      status: 'published',
    });
    await createEntry({
      scheduledFor: new Date('2026-08-19T09:00:00Z'),
      format: 'image',
      title: 'did not',
      caption: '',
      hashtags: [],
      mediaUrls: [],
    });

    const report = await weeklyReport(NOW);
    expect(report.planned).toBe(2);
    expect(report.posted).toBe(1);
    expect(report.missed).toBe(1);
  });

  it('reports an empty week without inventing anything', async () => {
    const report = await weeklyReport(NOW);
    expect(report.topPost).toBeNull();
    expect(metric(report, 'Posts published').value).toBe(0);
    expect(metric(report, 'Median reach').value).toBeNull();
  });
});
