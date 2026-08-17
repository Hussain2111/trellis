import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, jobs, posts, quotaBudget } from '../lib/db/schema';
import { inferAndStoreNiche } from '../lib/analysis/niche';
import { upsertAccount, upsertPosts } from '../lib/ingest/upsert';
import { FakeLlm, __setLlmForTests } from '../lib/providers/llm';
import type { ScrapedPost } from '../lib/providers/scraper/types';

let fake: FakeLlm;

beforeEach(() => {
  fake = new FakeLlm();
  __setLlmForTests(fake);
});

afterEach(async () => {
  __setLlmForTests(null);
  await db().delete(jobs);
  await db().delete(posts);
  await db().delete(accounts);
  // The daily quota budget is real state, not per-test — clear it so one
  // test's LLM calls can't exhaust the next test's allowance.
  await db().delete(quotaBudget);
});

afterAll(async () => {
  await closeDb();
});

const post = (overrides: Partial<ScrapedPost> = {}): ScrapedPost => ({
  shortcode: `S${Math.random()}`,
  type: 'reel',
  caption: 'hook\n\n#fitness #coaching',
  takenAt: 1_700_000_000,
  likes: 100,
  comments: 5,
  views: null,
  plays: null,
  durationS: null,
  carouselCount: null,
  thumbnailUrl: null,
  mediaUrls: [],
  isSponsored: false,
  raw: {},
  ...overrides,
});

describe('inferAndStoreNiche', () => {
  it('calls the LLM with the account bio, captions, and top hashtags, and stores the result', async () => {
    fake.queue(
      JSON.stringify({
        niche: 'boutique fitness coaching',
        description: 'For busy professionals.',
      }),
    );

    const account = await upsertAccount({ handle: 'coach', role: 'self' });
    await db()
      .update(accounts)
      .set({ bio: 'Helping you get strong.' })
      .where(eq(accounts.id, account.id));
    await upsertPosts(account.id, [post(), post({ shortcode: 'S2' })]);
    const [refreshedInput] = await db().select().from(accounts).where(eq(accounts.id, account.id));

    const result = await inferAndStoreNiche(refreshedInput!);

    expect(result.niche).toBe('boutique fitness coaching');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.operation).toBe('niche_inference');
    expect(fake.calls[0]?.prompt).toContain('#fitness');
    expect(fake.calls[0]?.prompt).toContain('Helping you get strong.');

    const [refreshed] = await db().select().from(accounts).where(eq(accounts.id, account.id));
    expect(refreshed?.niche).toBe('boutique fitness coaching');
  });

  it('repairs a malformed response once before giving up', async () => {
    fake.queue(
      'not json at all',
      JSON.stringify({ niche: 'recovered niche', description: 'a'.repeat(30) }),
    );

    const account = await upsertAccount({ handle: 'coach2', role: 'self' });
    const result = await inferAndStoreNiche(account);

    expect(result.niche).toBe('recovered niche');
    expect(fake.calls).toHaveLength(2);
  });
});
