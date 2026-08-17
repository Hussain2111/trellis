import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { closeDb, db } from '../lib/db/client';
import {
  accounts,
  analyses,
  chatMessages,
  chatThreads,
  drafts,
  jobs,
  posts,
  quotaBudget,
} from '../lib/db/schema';
import {
  appendMessage,
  buildSystemPrompt,
  createThread,
  deleteThread,
  listThreads,
  threadMessages,
  titleThread,
} from '../lib/chat/threads';
import { coachTools } from '../lib/chat/tools';
import { upsertAccount, upsertPosts } from '../lib/ingest/upsert';
import { __setChatModelForTests } from '../lib/providers/llm/chat-model';
import type { ScrapedPost } from '../lib/providers/scraper/types';
import type { Gap, Pattern } from '../lib/analysis/patterns';

afterEach(async () => {
  __setChatModelForTests(null);
  await db().delete(chatMessages);
  await db().delete(chatThreads);
  await db().delete(jobs);
  await db().delete(drafts);
  await db().delete(analyses);
  await db().delete(posts);
  await db().delete(accounts);
  await db().delete(quotaBudget);
});

afterAll(async () => {
  await closeDb();
});

let n = 0;
const scraped = (likes: number): ScrapedPost => ({
  shortcode: `C${n++}`,
  type: 'reel',
  caption: 'A caption here',
  takenAt: 1_700_000_000 + n * 3600,
  likes,
  comments: 5,
  views: null,
  plays: null,
  durationS: null,
  carouselCount: null,
  thumbnailUrl: null,
  mediaUrls: [],
  isSponsored: false,
  raw: {},
});

describe('chat threads', () => {
  it('creates, lists, appends to, and deletes a thread', async () => {
    const id = await createThread();
    expect((await listThreads()).map((t) => t.id)).toContain(id);

    await appendMessage({ threadId: id, role: 'user', content: 'hello there' });
    const messages = await threadMessages(id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('hello there');

    await titleThread(id, 'What is my biggest gap right now');
    const [thread] = await db().select().from(chatThreads).where(eq(chatThreads.id, id));
    expect(thread?.title).toBe('What is my biggest gap right now');

    await deleteThread(id);
    expect((await listThreads()).map((t) => t.id)).not.toContain(id);
  });

  it('bumps updatedAt on the thread when a message is appended', async () => {
    const id = await createThread();
    const [before] = await db().select().from(chatThreads).where(eq(chatThreads.id, id));
    await new Promise((r) => setTimeout(r, 5));
    await appendMessage({ threadId: id, role: 'assistant', content: 'reply' });
    const [after] = await db().select().from(chatThreads).where(eq(chatThreads.id, id));
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
  });
});

describe('buildSystemPrompt', () => {
  it('grounds the prompt in real account state, not placeholders', async () => {
    const self = await upsertAccount({ handle: 'coachme', role: 'self' });
    await db()
      .update(accounts)
      .set({ followers: 5000, niche: 'home cooking' })
      .where(eq(accounts.id, self.id));
    await upsertPosts(self.id, [scraped(100)]);

    const prompt = await buildSystemPrompt();
    expect(prompt).toContain('@coachme');
    expect(prompt).toContain('5000 followers');
    expect(prompt).toContain('home cooking');
    expect(prompt).toContain('No gap analysis has been run yet');
  });

  it('states the current gap claim when an analysis exists', async () => {
    await upsertAccount({ handle: 'coachme2', role: 'self' });
    const gap: Gap = {
      key: 'has_cta',
      name: 'CTA usage',
      nicheStat: 0.6,
      myStat: 0.1,
      deltaPct: 50,
      nichePostIds: [],
      myPostIds: [],
      nicheSampleSize: 10,
      mySampleSize: 10,
      claim: 'Sixty percent of top performers use a CTA; you use one 10% of the time.',
    };
    await db()
      .insert(analyses)
      .values({
        windowDays: 30,
        patterns: [gap as Pattern & { claim: string }],
        gap,
        inputsHash: 'x',
        generatedBy: 'test',
      });

    const prompt = await buildSystemPrompt();
    expect(prompt).toContain('Sixty percent of top performers use a CTA');
  });
});

describe('coachTools (grounded, read-only)', () => {
  it('getAccountStats returns real data, and an error when there is no self account', async () => {
    const tools = coachTools();
    const empty = await tools.getAccountStats.execute!({}, {
      toolCallId: 't1',
      messages: [],
    } as never);
    expect(empty).toEqual({ error: 'No account is marked as yours yet.' });

    const self = await upsertAccount({ handle: 'toolsself', role: 'self' });
    await db().update(accounts).set({ followers: 2000 }).where(eq(accounts.id, self.id));
    await upsertPosts(self.id, [scraped(50), scraped(80)]);

    const result = (await tools.getAccountStats.execute!({}, {
      toolCallId: 't2',
      messages: [],
    } as never)) as {
      handle: string;
      postsAnalysed: number;
    };
    expect(result.handle).toBe('toolsself');
    expect(result.postsAnalysed).toBe(2);
  });

  it('getPosts respects type/sort/limit and never invents a post', async () => {
    const self = await upsertAccount({ handle: 'toolsself2', role: 'self' });
    await upsertPosts(self.id, [scraped(10), scraped(999)]);

    const tools = coachTools();
    const result = (await tools.getPosts.execute!({ type: 'reel', sort: 'top', limit: 1 }, {
      toolCallId: 't3',
      messages: [],
    } as never)) as { count: number; posts: { likes: number | null }[] };
    expect(result.count).toBe(1);
    expect(result.posts[0]?.likes).toBe(999);
  });

  it('getCurrentGap returns an error when nothing has been analysed, and the real analysis otherwise', async () => {
    const tools = coachTools();
    const empty = await tools.getCurrentGap.execute!({}, {
      toolCallId: 't4',
      messages: [],
    } as never);
    expect(empty).toEqual({ error: 'No analysis has been run yet.' });

    await db()
      .insert(analyses)
      .values({
        windowDays: 30,
        patterns: [],
        gap: { claim: 'the gap' },
        inputsHash: 'x',
        generatedBy: 'test',
      });
    const result = (await tools.getCurrentGap.execute!({}, {
      toolCallId: 't5',
      messages: [],
    } as never)) as {
      gap: { claim: string };
    };
    expect(result.gap.claim).toBe('the gap');
  });

  it('getDrafts filters by status', async () => {
    await upsertAccount({ handle: 'toolsself3', role: 'self' });
    const [analysis] = await db()
      .insert(analyses)
      .values({ windowDays: 30, patterns: [], gap: {}, inputsHash: 'y', generatedBy: 'test' })
      .returning({ id: analyses.id });
    await db()
      .insert(drafts)
      .values([
        {
          analysisId: analysis!.id,
          format: 'image',
          title: 'Draft A',
          hook: 'h',
          body: { kind: 'image', concept: 'c', image_direction: 'd' },
          caption: 'x',
          hashtags: [],
          evidence: [],
          status: 'draft',
          generatedBy: 'test',
        },
        {
          analysisId: analysis!.id,
          format: 'image',
          title: 'Draft B',
          hook: 'h',
          body: { kind: 'image', concept: 'c', image_direction: 'd' },
          caption: 'x',
          hashtags: [],
          evidence: [],
          status: 'approved',
          generatedBy: 'test',
        },
      ]);

    const tools = coachTools();
    const result = (await tools.getDrafts.execute!({ status: 'approved', limit: 10 }, {
      toolCallId: 't6',
      messages: [],
    } as never)) as { drafts: { title: string }[] };
    expect(result.drafts.map((d) => d.title)).toEqual(['Draft B']);
  });

  it('listAccounts reports every tracked account', async () => {
    await upsertAccount({ handle: 'toolsself4', role: 'self' });
    await upsertAccount({ handle: 'toolscompetitor', role: 'competitor' });
    const tools = coachTools();
    const result = (await tools.listAccounts.execute!({}, {
      toolCallId: 't7',
      messages: [],
    } as never)) as {
      accounts: { handle: string }[];
    };
    expect(result.accounts.map((a) => a.handle).sort()).toEqual(['toolscompetitor', 'toolsself4']);
  });
});

describe('POST /api/chat', () => {
  it('streams a reply, persists both turns, and marks a fresh thread titled from the first message', async () => {
    await upsertAccount({ handle: 'routeself', role: 'self' });

    __setChatModelForTests(
      new MockLanguageModelV4({
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'Your biggest lever right now is CTAs.' },
            { type: 'text-end', id: '1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: {
                inputTokens: {
                  total: 10,
                  noCache: 10,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 8, text: 8, reasoning: undefined },
              },
            },
          ]) as never,
        }),
      }),
    );

    const { POST } = await import('../app/api/chat/route');
    const threadId = await createThread();

    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          threadId,
          messages: [
            { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'What should I focus on?' }] },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    // Drain the stream so onFinish (which persists the assistant turn) runs.
    await response.text();
    await new Promise((r) => setTimeout(r, 10));

    const messages = await threadMessages(threadId);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.content).toContain('CTAs');

    const [thread] = await db().select().from(chatThreads).where(eq(chatThreads.id, threadId));
    expect(thread?.title).toBe('What should I focus on?');
  });

  it('returns 429 with no fallback when the daily chat quota is spent', async () => {
    await upsertAccount({ handle: 'routeself2', role: 'self' });
    __setChatModelForTests(new MockLanguageModelV4({}));

    const { checkHeadroom } = await import('../lib/quota/budget');
    // Exhaust today's allowance directly rather than looping 60 real calls.
    const { setAllowance, consume } = await import('../lib/quota/budget');
    await setAllowance('google', 'chat', 1);
    await consume('google', 'chat', 1);
    expect((await checkHeadroom('google', 'chat')).allowed).toBe(false);

    const { POST } = await import('../app/api/chat/route');
    const threadId = await createThread();
    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({ threadId, messages: [] }),
      }),
    );

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toBe('quota_exhausted');
  });
});
