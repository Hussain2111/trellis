import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../lib/db/client';
import { accounts, analyses, drafts, posts, quotaBudget, voiceProfile } from '../lib/db/schema';
import { generateDraftBatch, NoAnalysis } from '../lib/analysis/drafts';
import { activeVoice, saveVoice } from '../lib/analysis/voice';
import { upsertAccount, upsertPosts } from '../lib/ingest/upsert';
import { FakeLlm, __setLlmForTests } from '../lib/providers/llm';
import type { ScrapedPost } from '../lib/providers/scraper/types';
import type { Gap, Pattern } from '../lib/analysis/patterns';

let fake: FakeLlm;

beforeEach(() => {
  fake = new FakeLlm();
  __setLlmForTests(fake);
});

afterEach(async () => {
  __setLlmForTests(null);
  await db().delete(drafts);
  await db().delete(analyses);
  await db().delete(voiceProfile);
  await db().delete(posts);
  await db().delete(accounts);
  await db().delete(quotaBudget);
});

afterAll(async () => {
  await closeDb();
});

let n = 0;
const scraped = (type: ScrapedPost['type']): ScrapedPost => ({
  shortcode: `D${n++}`,
  type,
  caption: 'x',
  takenAt: 1_700_000_000 + n * 3600,
  likes: 10,
  comments: 1,
  views: null,
  plays: null,
  durationS: null,
  carouselCount: null,
  thumbnailUrl: null,
  mediaUrls: [],
  isSponsored: false,
  raw: {},
});

const fakePattern = (index: number): Pattern & { claim: string } => ({
  key: `pattern-${index}`,
  name: `Pattern ${index}`,
  nicheStat: 0.5,
  myStat: 0.1,
  deltaPct: 40,
  nichePostIds: [],
  myPostIds: [],
  nicheSampleSize: 10,
  mySampleSize: 10,
  claim: `Claim for pattern ${index}`,
});

const fakeDraft = (
  format: 'reel' | 'carousel' | 'image',
  patternIndex: number,
  evidence: number[] = [],
) => ({
  format,
  title: `Draft ${format} ${Math.random()}`,
  hook: 'A hook',
  body:
    format === 'reel'
      ? {
          kind: 'reel',
          hook_line: 'hi',
          beats: [
            { shot: 'a', on_screen_text: 'b', spoken: 'c' },
            { shot: 'a', on_screen_text: 'b', spoken: 'c' },
            { shot: 'a', on_screen_text: 'b', spoken: 'c' },
          ],
        }
      : format === 'carousel'
        ? {
            kind: 'carousel',
            slides: [
              { heading: 'a', body: 'b' },
              { heading: 'a', body: 'b' },
              { heading: 'a', body: 'b' },
            ],
          }
        : { kind: 'image', concept: 'a', image_direction: 'b' },
  caption: 'A caption long enough to pass validation for sure.',
  hashtags: ['tag'],
  cta: 'Follow for more',
  rationale: 'Closes the gap because it does.',
  evidence,
  pattern_index: patternIndex,
});

async function seedSelfAndAnalysis(postTypes: ScrapedPost['type'][]) {
  const self = await upsertAccount({ handle: 'drafter', role: 'self' });
  await upsertPosts(self.id, postTypes.map(scraped));
  const gap: Gap = { ...fakePattern(0), claim: 'The gap claim' };
  const [analysis] = await db()
    .insert(analyses)
    .values({
      windowDays: 30,
      patterns: [fakePattern(0), fakePattern(1)],
      gap,
      inputsHash: 'x',
      generatedBy: 'test',
    })
    .returning({ id: analyses.id });
  return { self, analysisId: analysis!.id };
}

describe('activeVoice / saveVoice', () => {
  it('never overwrites a version — regenerating adds a new one and deactivates the old', async () => {
    await saveVoice({ markdown: 'v1', fields: emptyFields(), generatedBy: 'test' });
    await saveVoice({ markdown: 'v2', fields: emptyFields(), generatedBy: 'test' });

    const active = await activeVoice();
    expect(active?.markdown).toBe('v2');
    expect(active?.version).toBe(2);

    const all = await db().select().from(voiceProfile);
    expect(all).toHaveLength(2);
    expect(all.filter((v) => v.active)).toHaveLength(1);
  });
});

describe('generateDraftBatch', () => {
  it('throws NoAnalysis for an unknown analysis id', async () => {
    await expect(generateDraftBatch(999_999, 4)).rejects.toThrow(NoAnalysis);
  });

  it('generates the requested count across batches when the model cooperates', async () => {
    const { analysisId } = await seedSelfAndAnalysis(
      Array(8).fill('reel') as ScrapedPost['type'][],
    );
    // formatMix(8 reels, count=8) -> all reel, in batches of 4.
    fake.queue(
      JSON.stringify({
        drafts: [
          fakeDraft('reel', 0),
          fakeDraft('reel', 1),
          fakeDraft('reel', 0),
          fakeDraft('reel', 1),
        ],
      }),
    );
    fake.queue(
      JSON.stringify({
        drafts: [
          fakeDraft('reel', 0),
          fakeDraft('reel', 1),
          fakeDraft('reel', 0),
          fakeDraft('reel', 1),
        ],
      }),
    );

    const ids = await generateDraftBatch(analysisId, 8);
    expect(ids).toHaveLength(8);

    const stored = await db().select().from(drafts).where(eq(drafts.analysisId, analysisId));
    expect(stored).toHaveLength(8);
    expect(stored.every((d) => d.format === 'reel')).toBe(true);
  });

  it('clamps an out-of-range pattern_index and drops evidence for posts that do not exist', async () => {
    const { self, analysisId } = await seedSelfAndAnalysis(['reel']);
    const [realPost] = await db()
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.accountId, self.id));

    // 4 is schema-valid (draftSchema caps pattern_index at 4) but out of
    // range for THIS analysis, which only has 2 patterns (indices 0-1) —
    // exercises the clamp without the model response failing validation
    // (which would trigger a different code path: the repair retry).
    fake.queue(JSON.stringify({ drafts: [fakeDraft('image', 4, [realPost!.id, 999_999])] }));

    const ids = await generateDraftBatch(analysisId, 1);
    const [stored] = await db().select().from(drafts).where(eq(drafts.id, ids[0]!));

    expect(stored?.patternIndex).toBe(1); // clamped to patterns.length - 1
    expect(stored?.evidence).toEqual([realPost!.id]); // hallucinated id dropped
  });

  it('avoids repeating titles already drafted for this analysis', async () => {
    const { analysisId } = await seedSelfAndAnalysis(['reel', 'reel']);
    fake.queue(JSON.stringify({ drafts: [fakeDraft('reel', 0)] }));
    await generateDraftBatch(analysisId, 1);

    fake.queue(JSON.stringify({ drafts: [fakeDraft('reel', 0)] }));
    await generateDraftBatch(analysisId, 1);

    const secondCallPrompt = fake.calls[fake.calls.length - 1]?.prompt ?? '';
    expect(secondCallPrompt).toContain('ALREADY DRAFTED');
  });
});

function emptyFields() {
  return {
    tone: 't',
    sentence_rhythm: 'r',
    vocabulary: [],
    recurring_phrases: [],
    banned_words: [],
    cta_style: 'c',
    emoji_policy: 'e',
    formatting_habits: 'f',
    recurring_subjects: [],
  };
}
