import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, analyses, draftAssets, drafts, posts } from '../lib/db/schema';
import { registerJobHandlers } from '../lib/jobs/handlers';
import { enqueue, getJob } from '../lib/jobs/queue';
import { runTick } from '../lib/jobs/runner';
import { upsertAccount } from '../lib/ingest/upsert';

registerJobHandlers();

afterEach(async () => {
  await db().delete(draftAssets);
  await db().delete(drafts);
  await db().delete(analyses);
  await db().delete(posts);
  await db().delete(accounts);
});

afterAll(async () => {
  await closeDb();
});

async function seedCarouselDraft() {
  await upsertAccount({ handle: 'sliderself', role: 'self' });
  const [analysis] = await db()
    .insert(analyses)
    .values({ windowDays: 30, patterns: [], gap: {}, inputsHash: 'x', generatedBy: 'test' })
    .returning({ id: analyses.id });
  const [draft] = await db()
    .insert(drafts)
    .values({
      analysisId: analysis!.id,
      format: 'carousel',
      title: 'A test carousel',
      hook: 'The hook line',
      body: {
        kind: 'carousel',
        slides: [
          { heading: 'First point', body: 'Some supporting text.' },
          { heading: 'Second point', body: 'More supporting text.' },
        ],
      },
      caption: 'A caption.',
      hashtags: ['tag'],
      cta: 'Follow for more',
      evidence: [],
      generatedBy: 'test',
    })
    .returning({ id: drafts.id });
  return draft!.id;
}

describe('render_slides (IMAGE_PROVIDER=none, local storage fallback)', () => {
  it('renders one PNG per slide (hook + 2 body + cta) and stores real, non-trivial bytes', async () => {
    const draftId = await seedCarouselDraft();
    const jobId = await enqueue('render_slides', { draftId });
    const result = await runTick(['render_slides'], 15_000);
    expect(result.processed).toBe(1);

    const job = await getJob(jobId!);
    expect(job?.status).toBe('done');

    const assets = await db().select().from(draftAssets).where(eq(draftAssets.draftId, draftId));
    expect(assets).toHaveLength(4);
    expect(assets.map((a) => a.slideIndex).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      1, 2, 3, 4,
    ]);

    for (const asset of assets) {
      expect(asset.storagePath).toBe(`${draftId}/slide-${asset.slideIndex}.png`);
      expect(asset.publicUrl).toContain(`/api/assets/${draftId}/slide-${asset.slideIndex}.png`);

      const file = path.join(process.cwd(), 'data', 'assets', asset.storagePath!);
      expect(fs.existsSync(file)).toBe(true);
      const bytes = fs.readFileSync(file);
      expect(bytes.length).toBeGreaterThan(1000); // a real PNG, not an empty stub
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG magic bytes
    }
  }, 20_000);

  it('is idempotent: re-rendering replaces the prior asset set rather than accumulating', async () => {
    const draftId = await seedCarouselDraft();
    await enqueue('render_slides', { draftId });
    await runTick(['render_slides'], 15_000);

    await enqueue('render_slides', { draftId });
    await runTick(['render_slides'], 15_000);

    const assets = await db().select().from(draftAssets).where(eq(draftAssets.draftId, draftId));
    expect(assets).toHaveLength(4);
  }, 30_000);

  it('no-ops cleanly for a non-carousel draft', async () => {
    await upsertAccount({ handle: 'sliderself2', role: 'self' });
    const [analysis] = await db()
      .insert(analyses)
      .values({ windowDays: 30, patterns: [], gap: {}, inputsHash: 'y', generatedBy: 'test' })
      .returning({ id: analyses.id });
    const [draft] = await db()
      .insert(drafts)
      .values({
        analysisId: analysis!.id,
        format: 'reel',
        title: 'A reel',
        hook: 'hook',
        body: { kind: 'reel', hook_line: 'x', beats: [] },
        caption: 'x',
        hashtags: [],
        evidence: [],
        generatedBy: 'test',
      })
      .returning({ id: drafts.id });

    const jobId = await enqueue('render_slides', { draftId: draft!.id });
    await runTick(['render_slides'], 5_000);

    const job = await getJob(jobId!);
    expect(job?.status).toBe('done');
    const assets = await db().select().from(draftAssets).where(eq(draftAssets.draftId, draft!.id));
    expect(assets).toHaveLength(0);
  });
});
