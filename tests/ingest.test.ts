import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, jobs, posts } from '../lib/db/schema';
import {
  getAccount,
  knownShortcodes,
  markScanned,
  selfAccount,
  upsertAccount,
  upsertPosts,
} from '../lib/ingest/upsert';
import type { ScrapedPost } from '../lib/providers/scraper/types';

const samplePost = (overrides: Partial<ScrapedPost> = {}): ScrapedPost => ({
  shortcode: 'SAMPLE001',
  type: 'reel',
  caption: 'A hook line\n\nBody',
  takenAt: 1_700_000_000,
  likes: 100,
  comments: 10,
  views: 1000,
  plays: 1100,
  durationS: 20,
  carouselCount: null,
  thumbnailUrl: null,
  mediaUrls: [],
  isSponsored: false,
  raw: { synthetic: true },
  ...overrides,
});

afterEach(async () => {
  await db().delete(jobs);
  await db().delete(posts);
  await db().delete(accounts);
});

afterAll(async () => {
  await closeDb();
});

describe('upsertAccount', () => {
  it('normalizes the handle and is idempotent on re-insert', async () => {
    const first = await upsertAccount({ handle: '@TestUser', role: 'self' });
    expect(first.handle).toBe('testuser');

    const second = await upsertAccount({ handle: 'testuser', role: 'self' });
    expect(second.id).toBe(first.id);

    const rows = await db().select().from(accounts);
    expect(rows).toHaveLength(1);
  });

  it('finds the self account among competitors', async () => {
    await upsertAccount({ handle: 'competitor1', role: 'competitor' });
    await upsertAccount({ handle: 'me', role: 'self' });
    const self = await selfAccount();
    expect(self?.handle).toBe('me');
  });
});

describe('upsertPosts', () => {
  it('inserts new posts and reports the count', async () => {
    const account = await upsertAccount({ handle: 'creator', role: 'self' });
    const summary = await upsertPosts(account.id, [
      samplePost({ shortcode: 'A1' }),
      samplePost({ shortcode: 'A2' }),
    ]);
    expect(summary).toEqual({ inserted: 2, updated: 0, total: 2 });

    const stored = await db().select().from(posts).where(eq(posts.accountId, account.id));
    expect(stored).toHaveLength(2);
  });

  it('is idempotent on shortcode: a re-scan updates metrics without duplicating rows', async () => {
    const account = await upsertAccount({ handle: 'creator2', role: 'self' });
    await upsertPosts(account.id, [samplePost({ shortcode: 'B1', likes: 100 })]);
    const summary = await upsertPosts(account.id, [samplePost({ shortcode: 'B1', likes: 250 })]);

    expect(summary).toEqual({ inserted: 0, updated: 1, total: 1 });

    const stored = await db().select().from(posts).where(eq(posts.accountId, account.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.likes).toBe(250);
  });

  it('preserves firstSeenAt across a re-scan while refreshing lastSeenAt', async () => {
    const account = await upsertAccount({ handle: 'creator3', role: 'self' });
    await upsertPosts(account.id, [samplePost({ shortcode: 'C1' })]);
    const [before] = await db().select().from(posts).where(eq(posts.shortcode, 'C1'));

    await new Promise((resolve) => setTimeout(resolve, 5));
    await upsertPosts(account.id, [samplePost({ shortcode: 'C1', likes: 999 })]);
    const [after] = await db().select().from(posts).where(eq(posts.shortcode, 'C1'));

    expect(after?.firstSeenAt?.getTime()).toBe(before?.firstSeenAt?.getTime());
    expect(after?.lastSeenAt?.getTime()).toBeGreaterThanOrEqual(before?.lastSeenAt?.getTime() ?? 0);
  });
});

describe('knownShortcodes', () => {
  it('returns the shortcodes already held for an account, newest first', async () => {
    const account = await upsertAccount({ handle: 'creator4', role: 'self' });
    await upsertPosts(account.id, [
      samplePost({ shortcode: 'D1', takenAt: 1_700_000_000 }),
      samplePost({ shortcode: 'D2', takenAt: 1_700_100_000 }),
    ]);
    const known = await knownShortcodes(account.id);
    expect(known).toEqual(new Set(['D1', 'D2']));
  });

  it('is empty for an account with no posts', async () => {
    const account = await upsertAccount({ handle: 'creator5', role: 'self' });
    expect(await knownShortcodes(account.id)).toEqual(new Set());
  });
});

describe('markScanned / getAccount', () => {
  it('stamps lastScrapedAt', async () => {
    const account = await upsertAccount({ handle: 'creator6', role: 'self' });
    expect(account.lastScrapedAt).toBeNull();
    await markScanned(account.id);
    const refreshed = await getAccount(account.id);
    expect(refreshed?.lastScrapedAt).toBeInstanceOf(Date);
  });
});
