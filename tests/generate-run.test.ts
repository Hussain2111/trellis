import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, generations, postInsights, posts, quotaBudget, runs } from '../lib/db/schema';
import { FakeLlm, __setLlmForTests } from '../lib/providers/llm';
import { __setEnvForTests, envSchema } from '../lib/env';
import { generateOpportunities } from '../lib/generate/run';
import { buildOpportunitiesPayload, MIN_MEASURED_POSTS } from '../lib/generate/payload';
import { currentWeekStart, readGeneration } from '../lib/generate/store';
import { upsertAccount } from '../lib/ingest/upsert';

afterEach(async () => {
  __setLlmForTests(null);
  __setEnvForTests(null);
  await db().delete(generations);
  await db().delete(postInsights);
  await db().delete(posts);
  await db().delete(accounts);
  await db().delete(runs);
  await db().delete(quotaBudget);
});

afterAll(async () => {
  await closeDb();
});

function fakeEnv() {
  __setEnvForTests(
    envSchema.parse({
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/trellis',
      LLM_PROVIDER: 'fake',
    }),
  );
}

let n = 0;
async function seedMeasured(accountId: number, reach: number, type: 'reel' | 'image' = 'reel') {
  const [row] = await db()
    .insert(posts)
    .values({
      accountId,
      shortcode: `G${++n}`,
      type,
      takenAt: new Date(),
      likes: 10,
      comments: 2,
      source: 'graph',
      raw: {},
    })
    .returning({ id: posts.id });
  await db()
    .insert(postInsights)
    .values({ postId: row!.id, checkpoint: 'latest', reach, totalInteractions: 12 });
  return row!.id;
}

describe('payload assembly', () => {
  it('refuses to send thin data to the model at all', async () => {
    const self = await upsertAccount({ handle: 'gen1', role: 'self' });
    await seedMeasured(self.id, 100);

    const payload = await buildOpportunitiesPayload();
    expect(payload!.insufficient).toMatch(new RegExp(String(MIN_MEASURED_POSTS)));
    // Thin data never reaches the model — it cannot caveat its way around
    // what it was never given.
    expect(payload!.ownPosts).toHaveLength(0);
    expect(payload!.formats).toHaveLength(0);
  });

  it('applies the per-format sample floor before the call', async () => {
    const self = await upsertAccount({ handle: 'gen2', role: 'self' });
    for (let i = 0; i < 6; i++) await seedMeasured(self.id, 1000, 'reel');
    // Two images is below MIN_FORMAT_SAMPLE (3).
    for (let i = 0; i < 2; i++) await seedMeasured(self.id, 50, 'image');

    const payload = await buildOpportunitiesPayload();
    expect(payload!.formats.map((f) => f.type)).toEqual(['reel']);
  });
});

describe('generateOpportunities', () => {
  it('stores a validated generation and reads back from cache', async () => {
    fakeEnv();
    const self = await upsertAccount({ handle: 'gen3', role: 'self' });
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push(await seedMeasured(self.id, 1000));

    const llm = new FakeLlm();
    llm.queue(
      JSON.stringify({
        insights: [
          {
            finding: 'Your reels reach a median of 1000, which is your strongest format.',
            direction: 'do_more',
            action: 'Keep making reels.',
            postIds: [ids[0]],
          },
        ],
      }),
    );
    __setLlmForTests(llm);

    const outcome = await generateOpportunities();
    expect(outcome.status).toBe('ok');

    const stored = await readGeneration('opportunities', currentWeekStart());
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe('ok');
    // The payload is stored alongside the output: without it a stored insight
    // could never be re-checked.
    expect(stored!.payload).toBeTruthy();
    expect(llm.calls).toHaveLength(1);
  });

  it('drops an insight that invents a figure and records why', async () => {
    fakeEnv();
    const self = await upsertAccount({ handle: 'gen4', role: 'self' });
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push(await seedMeasured(self.id, 1000));

    const llm = new FakeLlm();
    llm.queue(
      JSON.stringify({
        insights: [
          {
            // The post id is real; only the figure is invented. That is the
            // case the number guard exists for.
            finding: 'Your reels reach a median of 8888, well above average.',
            direction: 'do_more',
            action: 'Make more reels next week.',
            postIds: [ids[0]],
          },
        ],
      }),
    );
    __setLlmForTests(llm);

    const outcome = await generateOpportunities();
    // Nothing survived, so the page falls back to the deterministic read.
    expect(outcome.status).toBe('fallback');
    expect(outcome.dropped).toBe(1);
    expect(outcome.notes.join(' ')).toMatch(/8888/);

    const stored = await readGeneration('opportunities', currentWeekStart());
    expect(stored!.status).toBe('fallback');
    expect((stored!.output as { insights: unknown[] }).insights).toHaveLength(0);
  });

  it('falls back rather than throwing when the model fails outright', async () => {
    fakeEnv();
    const self = await upsertAccount({ handle: 'gen5', role: 'self' });
    for (let i = 0; i < 6; i++) await seedMeasured(self.id, 1000);

    const llm = new FakeLlm();
    // Not JSON, twice — the repair path also fails.
    llm.queue('sorry, I cannot help with that', 'still not JSON');
    __setLlmForTests(llm);

    const outcome = await generateOpportunities();
    expect(outcome.status).toBe('fallback');

    const stored = await readGeneration('opportunities', currentWeekStart());
    expect(stored!.status).toBe('fallback');
    expect(stored!.generatedBy).toBe('failed');
    expect(stored!.validationNotes.join(' ')).toMatch(/failed/i);
  });

  it('overwrites the same week rather than accumulating rows', async () => {
    fakeEnv();
    const self = await upsertAccount({ handle: 'gen6', role: 'self' });
    for (let i = 0; i < 6; i++) await seedMeasured(self.id, 1000);

    const llm = new FakeLlm();
    __setLlmForTests(llm);
    await generateOpportunities();
    await generateOpportunities();

    const rows = await db().select().from(generations);
    expect(rows).toHaveLength(1);
  });
});
