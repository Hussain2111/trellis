import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, calendarEntries, postInsights, posts } from '../lib/db/schema';
import { calendarView, overdueCount } from '../lib/publish/calendar-view';
import { createEntry } from '../lib/publish/schedule';
import { isOverdue, riyadhDay, startOfWeekRiyadh } from '../lib/time';
import { upsertAccount } from '../lib/ingest/upsert';

afterEach(async () => {
  await db().delete(postInsights);
  await db().delete(calendarEntries);
  await db().delete(posts);
  await db().delete(accounts);
});

afterAll(async () => {
  await closeDb();
});

const entry = (scheduledFor: Date, overrides: Record<string, unknown> = {}) =>
  createEntry({
    scheduledFor,
    format: 'image',
    title: 'A post',
    caption: '',
    hashtags: [],
    mediaUrls: [],
    ...overrides,
  });

describe('Riyadh week bucketing', () => {
  it('puts a Monday 01:00 Riyadh entry in that Monday week, not the Sunday before', () => {
    // 22:00 UTC Sunday is 01:00 Monday in Riyadh.
    const sundayNightUtc = new Date('2026-08-16T22:00:00Z');
    expect(riyadhDay(sundayNightUtc)).toBe('2026-08-17');
    expect(riyadhDay(startOfWeekRiyadh(sundayNightUtc))).toBe('2026-08-17');
  });

  it('starts the week on Monday, not Sunday', () => {
    const wednesday = new Date('2026-08-19T09:00:00Z');
    expect(riyadhDay(startOfWeekRiyadh(wednesday))).toBe('2026-08-17');
  });
});

describe('calendarView', () => {
  it('separates due and overdue entries into the needs-posting list', async () => {
    const now = new Date('2026-08-19T12:00:00Z'); // 15:00 Riyadh
    await entry(new Date('2026-08-19T06:00:00Z')); // earlier today → due
    await entry(new Date('2026-08-17T06:00:00Z')); // two days ago → overdue
    await entry(new Date('2026-08-25T06:00:00Z')); // next week → planned

    const view = await calendarView(now);
    expect(view.needsAttention).toHaveLength(2);
    expect(view.needsAttention.map((r) => r.state)).toEqual(['overdue', 'due']);
    expect(view.counts.planned).toBe(1);
  });

  it('groups into Riyadh weeks and labels this week and next', async () => {
    const now = new Date('2026-08-19T12:00:00Z');
    await entry(new Date('2026-08-20T09:00:00Z'));
    await entry(new Date('2026-08-26T09:00:00Z'));

    const view = await calendarView(now);
    expect(view.weeks.map((w) => w.label)).toEqual(['This week', 'Next week']);
  });

  it('attaches real performance only to entries with a recorded media id', async () => {
    const now = new Date('2026-08-19T12:00:00Z');
    const account = await upsertAccount({ handle: 'calself', role: 'self' });
    const [post] = await db()
      .insert(posts)
      .values({
        accountId: account.id,
        shortcode: 'PUB',
        type: 'image',
        igMediaId: 'media-1',
        source: 'graph',
        raw: {},
      })
      .returning({ id: posts.id });
    await db()
      .insert(postInsights)
      .values({ postId: post!.id, checkpoint: 'latest', reach: 4200, totalInteractions: 310 });

    await entry(new Date('2026-08-18T09:00:00Z'), {
      status: 'published',
      igMediaId: 'media-1',
    });
    // Posted by hand — no media id, so no link back to what it became.
    await entry(new Date('2026-08-18T10:00:00Z'), { status: 'published' });

    const view = await calendarView(now);
    const rows = view.weeks.flatMap((w) => w.rows);
    const linked = rows.find((r) => r.entry.igMediaId === 'media-1')!;
    const unlinked = rows.find((r) => r.entry.igMediaId === null)!;

    expect(linked.outcome).toEqual({ reach: 4200, totalInteractions: 310 });
    // Guessing by timestamp would attach real numbers to the wrong row.
    expect(unlinked.outcome).toBeNull();
  });

  it('counts overdue entries without counting published ones', async () => {
    const now = new Date('2026-08-19T12:00:00Z');
    await entry(new Date('2026-08-10T09:00:00Z'));
    await entry(new Date('2026-08-10T10:00:00Z'), { status: 'published' });
    expect(await overdueCount(now)).toBe(1);
  });
});

describe('isOverdue', () => {
  it('is false for something due earlier the same Riyadh day', () => {
    const now = new Date('2026-08-19T12:00:00Z'); // 15:00 Riyadh
    expect(isOverdue(new Date('2026-08-19T06:00:00Z'), now)).toBe(false);
  });

  it('is true once the Riyadh day has rolled over', () => {
    const now = new Date('2026-08-19T12:00:00Z');
    expect(isOverdue(new Date('2026-08-18T20:00:00Z'), now)).toBe(true);
  });

  it('uses the Riyadh day boundary, not the UTC one', () => {
    // 22:00 UTC on the 18th is already the 19th in Riyadh, so from 15:00
    // Riyadh on the 19th it is same-day: due, not overdue.
    const now = new Date('2026-08-19T12:00:00Z');
    expect(isOverdue(new Date('2026-08-18T22:00:00Z'), now)).toBe(false);
  });
});
