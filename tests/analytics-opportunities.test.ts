import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, analyses, hookLabels, postInsights, posts } from '../lib/db/schema';
import { opportunities } from '../lib/analytics/opportunities';
import { upsertAccount } from '../lib/ingest/upsert';

afterEach(async () => {
  await db().delete(hookLabels);
  await db().delete(postInsights);
  await db().delete(analyses);
  await db().delete(posts);
  await db().delete(accounts);
});

afterAll(async () => {
  await closeDb();
});

let n = 0;
async function seedPost(
  accountId: number,
  options: { type?: 'image' | 'reel'; reach?: number; hook?: string } = {},
) {
  const [row] = await db()
    .insert(posts)
    .values({
      accountId,
      shortcode: `O${++n}`,
      type: options.type ?? 'image',
      takenAt: new Date(),
      source: 'graph',
      raw: {},
    })
    .returning({ id: posts.id });
  if (options.reach != null) {
    await db()
      .insert(postInsights)
      .values({ postId: row!.id, checkpoint: 'latest', reach: options.reach });
  }
  if (options.hook) {
    await db()
      .insert(hookLabels)
      .values({ postId: row!.id, category: options.hook, generatedBy: 'test' });
  }
  return row!.id;
}

function pattern(overrides: Record<string, unknown> = {}) {
  return {
    key: 'has_cta',
    name: 'CTA usage',
    nicheStat: 0.8,
    myStat: 0.2,
    deltaPct: 60,
    nichePostIds: [1, 2, 3],
    myPostIds: [4],
    nicheSampleSize: 20,
    mySampleSize: 20,
    claim: 'Eighty percent of them, twenty percent of you.',
    ...overrides,
  };
}

async function storeAnalysis(patterns: unknown[]) {
  await db()
    .insert(analyses)
    .values({
      windowDays: 30,
      patterns,
      gap: null,
      inputsHash: `h${Math.random()}`,
      generatedBy: 'test',
    });
}

describe('opportunities', () => {
  it('says so plainly when there is no account at all', async () => {
    const result = await opportunities();
    expect(result.opportunities).toHaveLength(0);
    expect(result.notes[0]).toMatch(/No account/);
  });

  it('surfaces a pattern gap with its claim and receipts', async () => {
    await upsertAccount({ handle: 'opp1', role: 'self' });
    await storeAnalysis([pattern()]);

    const { opportunities: list } = await opportunities();
    const found = list.find((o) => o.kind === 'pattern')!;
    expect(found.title).toBe('CTA usage');
    expect(found.detail).toBe('Eighty percent of them, twenty percent of you.');
    expect(found.receipts).toEqual([1, 2, 3]);
  });

  it('ignores patterns where you already do it more than the niche', async () => {
    await upsertAccount({ handle: 'opp2', role: 'self' });
    await storeAnalysis([pattern({ nicheStat: 0.2, myStat: 0.9, deltaPct: -70 })]);

    const { opportunities: list } = await opportunities();
    expect(list.filter((o) => o.kind === 'pattern')).toHaveLength(0);
  });

  it('ignores patterns computed from too few posts, and says why', async () => {
    await upsertAccount({ handle: 'opp3', role: 'self' });
    await storeAnalysis([pattern({ nicheSampleSize: 2, mySampleSize: 2 })]);

    const result = await opportunities();
    expect(result.opportunities.filter((o) => o.kind === 'pattern')).toHaveLength(0);
    expect(result.notes.join(' ')).toMatch(/too few/);
  });

  it('spots a format that out-reaches your median but that you rarely post', async () => {
    const self = await upsertAccount({ handle: 'opp4', role: 'self' });
    // Nine ordinary images, two far-reaching reels.
    for (let i = 0; i < 9; i++) await seedPost(self.id, { type: 'image', reach: 100 });
    for (let i = 0; i < 2; i++) await seedPost(self.id, { type: 'reel', reach: 1000 });

    const { opportunities: list } = await opportunities();
    const format = list.find((o) => o.kind === 'format')!;
    expect(format.title).toMatch(/reel/);
    expect(format.detail).toMatch(/1,000/);
    expect(format.receipts.length).toBeGreaterThan(0);
  });

  it('stays quiet about formats when too few posts carry reach', async () => {
    const self = await upsertAccount({ handle: 'opp5', role: 'self' });
    await seedPost(self.id, { type: 'reel', reach: 1000 });

    const result = await opportunities();
    expect(result.opportunities.filter((o) => o.kind === 'format')).toHaveLength(0);
    expect(result.notes.join(' ')).toMatch(/reach/);
  });

  it('names hook styles the niche uses that you never have', async () => {
    const self = await upsertAccount({ handle: 'opp6', role: 'self' });
    const rival = await upsertAccount({ handle: 'opp6r', role: 'competitor' });
    for (let i = 0; i < 6; i++) await seedPost(rival.id, { hook: 'bold_claim' });
    await seedPost(self.id, { hook: 'question' });

    const { opportunities: list } = await opportunities();
    const hook = list.find((o) => o.kind === 'hook')!;
    expect(hook.title).toMatch(/bold claim/);
    expect(hook.myStat).toBe(0);
    expect(hook.sampleSize).toBe(6);
  });

  it('does not suggest a hook style you already use', async () => {
    const self = await upsertAccount({ handle: 'opp7', role: 'self' });
    const rival = await upsertAccount({ handle: 'opp7r', role: 'competitor' });
    for (let i = 0; i < 6; i++) await seedPost(rival.id, { hook: 'bold_claim' });
    await seedPost(self.id, { hook: 'bold_claim' });

    const { opportunities: list } = await opportunities();
    expect(list.filter((o) => o.kind === 'hook')).toHaveLength(0);
  });

  it('ranks the widest gap first across all three sources', async () => {
    const self = await upsertAccount({ handle: 'opp8', role: 'self' });
    const rival = await upsertAccount({ handle: 'opp8r', role: 'competitor' });
    await storeAnalysis([pattern({ deltaPct: 90 })]);
    for (let i = 0; i < 6; i++) await seedPost(rival.id, { hook: 'listicle' });

    const { opportunities: list } = await opportunities();
    expect(list.length).toBeGreaterThan(1);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]!.weight).toBeGreaterThanOrEqual(list[i]!.weight);
    }
    void self;
  });
});
