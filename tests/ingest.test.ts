import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropTempDb, useTempDb } from './helpers';
import { normalizeDataset, normalizePost, normalizePostType } from '@/lib/ingest/normalize';
import { estimateCost } from '@/lib/ingest/budget';
import {
  knownShortcodes,
  isScanDue,
  listAccounts,
  upsertAccount,
  upsertPosts,
} from '@/lib/ingest/upsert';
import { FakeScraper } from '@/lib/providers/scraper/fake';
import { recordRun } from '@/lib/runs/log';
import type { Account } from '@/lib/db/schema';

beforeAll(() => useTempDb());
afterAll(() => dropTempDb());

describe('actor payload normalisation', () => {
  it('reads whichever field name the actor happens to use', () => {
    const camel = normalizePost({ shortCode: 'A1', likesCount: 10, commentsCount: 2 });
    const snake = normalizePost({ shortcode: 'A2', like_count: 10, comment_count: 2 });
    expect(camel?.likes).toBe(10);
    expect(snake?.likes).toBe(10);
    expect(snake?.comments).toBe(2);
  });

  it('accepts timestamps in seconds, milliseconds or ISO', () => {
    expect(normalizePost({ shortcode: 'A', timestamp: 1700000000 })?.takenAt).toBe(1700000000);
    expect(normalizePost({ shortcode: 'B', timestamp: 1700000000000 })?.takenAt).toBe(1700000000);
    expect(normalizePost({ shortcode: 'C', timestamp: '2023-11-14T22:13:20Z' })?.takenAt).toBe(
      1700000000,
    );
  });

  it('classifies post types across actor vocabularies', () => {
    expect(normalizePostType({ type: 'Sidecar' })).toBe('carousel');
    expect(normalizePostType({ productType: 'clips' })).toBe('reel');
    expect(normalizePostType({ __typename: 'GraphImage' })).toBe('image');
    expect(normalizePostType({ childPosts: [{}, {}] })).toBe('carousel');
    expect(normalizePostType({ isVideo: true, videoDuration: 30 })).toBe('reel');
    expect(normalizePostType({ isVideo: true, videoDuration: 600 })).toBe('video');
    expect(normalizePostType({})).toBe('unknown');
  });

  it('keeps the untouched payload so re-normalising never costs a scrape', () => {
    const raw = { shortcode: 'A', somethingNew: { nested: true } };
    expect(normalizePost(raw)?.raw).toEqual(raw);
  });

  it('drops rows with no shortcode rather than inventing one', () => {
    expect(normalizePost({ likesCount: 4 })).toBeNull();
  });

  it('handles both flat post lists and profile-with-nested-posts', () => {
    const flat = normalizeDataset([{ shortcode: 'A' }, { shortcode: 'B' }], 'me');
    expect(flat.posts).toHaveLength(2);

    const nested = normalizeDataset(
      [{ username: 'me', followersCount: 900, latestPosts: [{ shortcode: 'C' }] }],
      'me',
    );
    expect(nested.posts).toHaveLength(1);
    expect(nested.profile?.followers).toBe(900);
  });
});

describe('credit budgeting', () => {
  it('quotes a price before anything is scraped', () => {
    const estimate = estimateCost(100, 5);
    expect(estimate.items).toBe(100);
    expect(estimate.costUsd).toBeGreaterThan(0);
    expect(estimate.affordable).toBe(true);
  });

  it('refuses a scan the month cannot pay for', () => {
    const estimate = estimateCost(100_000, 5);
    expect(estimate.affordable).toBe(false);
    expect(estimate.note).toMatch(/only \$5\.00 is left/);
  });

  it('subtracts what has already been spent this month', () => {
    recordRun({
      provider: 'apify',
      operation: 'scrape',
      status: 'ok',
      costEstimate: 4.9,
      meta: { items: 2000 },
    });
    const estimate = estimateCost(500, 5);
    expect(estimate.affordable).toBe(false);
  });
});

describe('upsert', () => {
  let account: Account;

  it('creates an account, normalising the handle', () => {
    account = upsertAccount({ handle: '@Someone', role: 'self' });
    expect(account.handle).toBe('someone');
    expect(listAccounts('self')).toHaveLength(1);
  });

  it('is idempotent on shortcode and never loses first-seen history', async () => {
    const scraper = new FakeScraper();
    const first = await scraper.scrape({ handle: 'someone', limit: 20 });

    const a = upsertPosts(account.id, first.posts);
    expect(a.inserted).toBe(20);

    const b = upsertPosts(account.id, first.posts);
    expect(b.inserted).toBe(0);
    expect(b.updated).toBe(20);
  });

  it('refreshes metrics on re-scan', async () => {
    const scraper = new FakeScraper();
    const result = await scraper.scrape({ handle: 'someone', limit: 5 });
    const bumped = result.posts.map((p) => ({ ...p, likes: 99_999 }));
    upsertPosts(account.id, bumped);

    const { db } = await import('@/lib/db/client');
    const { posts } = await import('@/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    const row = db().select().from(posts).where(eq(posts.shortcode, bumped[0]!.shortcode)).get();
    expect(row?.likes).toBe(99_999);
  });

  it('offers the known shortcodes that make an incremental scan cheap', () => {
    const known = knownShortcodes(account.id);
    expect(known.size).toBeGreaterThan(0);
  });

  it('stops a scrape at the first already-known post', async () => {
    const scraper = new FakeScraper();
    const known = knownShortcodes(account.id);
    const result = await scraper.scrape({ handle: 'someone', limit: 20, stopAtShortcodes: known });
    expect(result.posts).toHaveLength(0);
  });

  it('gives different handles different shortcodes', async () => {
    const scraper = new FakeScraper();
    const one = await scraper.scrape({ handle: 'niche_one', limit: 5 });
    const two = await scraper.scrape({ handle: 'niche_two', limit: 5 });
    const overlap = one.posts.filter((p) => two.posts.some((q) => q.shortcode === p.shortcode));
    expect(overlap).toHaveLength(0);
  });

  it('respects the scan cooldown', () => {
    const nowS = Math.floor(Date.now() / 1000);
    expect(isScanDue({ ...account, lastScrapedAt: null }, 7)).toBe(true);
    expect(isScanDue({ ...account, lastScrapedAt: nowS - 86400 }, 7)).toBe(false);
    expect(isScanDue({ ...account, lastScrapedAt: nowS - 8 * 86400 }, 7)).toBe(true);
  });
});
