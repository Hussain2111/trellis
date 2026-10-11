import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import { z } from 'zod';
import { POST } from '../app/api/chat/route';

const state = vi.hoisted(() => ({
  appendChatTurn: vi.fn(),
  runs: vi.fn(),
  resolveLanes: vi.fn(),
  execute: vi.fn(),
  checkHeadroom: vi.fn(),
  headroom: { allowed: true, used: 0, limit: 80 },
}));
vi.mock('../lib/db/client', () => ({ db: () => ({ insert: () => ({ values: state.runs }) }) }));
vi.mock('../lib/chat/threads', () => ({
  appendChatTurn: state.appendChatTurn,
  selfAccountId: async () => 1,
  findThread: async () => ({ sourceCardId: null }),
  threadMessages: async () => [{ role: 'assistant', content: 'Which measure?' }],
  titleThread: async () => {},
  buildSystemPrompt: async () => 'Use queried evidence.',
  ledgerFor: (provider: string) => ({ provider }),
}));
vi.mock('../lib/model/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/model/provider')>()),
  resolveLanes: state.resolveLanes,
  checkHeadroom: state.checkHeadroom,
  quotaCaps: () => ({ dailyCalls: 100, reservedForCards: 20, callsPerMinute: 5 }),
}));
vi.mock('../lib/chat/tools', () => ({
  chatTools: () => ({
    getPostsRanked: tool({ inputSchema: z.object({}), execute: state.execute }),
  }),
}));

function apiError(statusCode?: number) {
  return new APICallError({
    message: 'private provider detail',
    url: 'https://example.test',
    requestBodyValues: {},
    statusCode,
    isRetryable: true,
  });
}

function response(text?: string): LanguageModelV3GenerateResult {
  return {
    content:
      text === undefined
        ? [{ type: 'tool-call', toolCallId: 'lookup', toolName: 'getPostsRanked', input: '{}' }]
        : [{ type: 'text', text }],
    finishReason: { unified: text === undefined ? 'tool-calls' : 'stop', raw: undefined },
    warnings: [],
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    },
  };
}
const lane = (model: MockLanguageModelV3, provider = 'google', isFallback = false) => ({
  model,
  provider,
  modelId: 'test',
  isFallback,
});
const request = () =>
  new Request('http://localhost/api/chat', {
    method: 'POST',
    body: JSON.stringify({ threadId: 11, message: 'Highest views?' }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  state.execute.mockResolvedValue({ views: 1248 });
  state.checkHeadroom.mockImplementation(async () => state.headroom);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.headroom = { allowed: true, used: 0, limit: 80 };
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('buffered chat response and provider accounting', () => {
  it('correlates request metadata and separates model/tool time from persistence without recording text', async () => {
    vi.stubEnv('TRELLIS_PERFORMANCE', '1');
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        calls += 1;
        return calls < 4 ? response() : response('1248 views.');
      },
    });
    state.resolveLanes.mockReturnValue([lane(model)]);
    const id = 'a1d79f8a-9bcb-4517-8ddc-45748b9ab31d';
    const result = await POST(
      new Request('http://localhost/api/chat', {
        headers: { 'x-trellis-request-id': id },
        method: 'POST',
        body: JSON.stringify({ threadId: 11, message: 'Private conversation; never export this' }),
      }),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get('x-trellis-request-id')).toBe(id);
    const log = vi.mocked(console.info).mock.calls.find(([prefix]) => prefix === '[performance]')!;
    const metadata = JSON.parse(log[1] as string);
    expect(metadata.counters).toMatchObject({
      modelCalls: 4,
      historyMessages: 1,
      inputTokens: 40,
      outputTokens: 20,
    });
    expect(metadata.stages.model.count).toBe(4);
    expect(metadata.stages.model.wallMs).toBeGreaterThan(30);
    expect(metadata.stages.tool.count).toBe(3);
    expect(metadata.stages.persistence.count).toBe(2);
    expect(metadata.stages.validation.count).toBe(1);
    expect(metadata.otherRequestMs).toBeGreaterThanOrEqual(0);
    expect(log[1]).not.toContain('Private conversation');
    expect(log[1]).not.toContain('1248 views.');
  });

  it('records the duration of a rejected model call without exporting its error', async () => {
    vi.stubEnv('TRELLIS_PERFORMANCE', '1');
    state.resolveLanes.mockReturnValue([
      lane(
        new MockLanguageModelV3({
          doGenerate: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw new Error('Private provider response');
          },
        }),
      ),
    ]);
    expect((await POST(request())).status).toBe(500);
    const log = vi.mocked(console.info).mock.calls.find(([prefix]) => prefix === '[performance]')!;
    const metadata = JSON.parse(log[1] as string);
    expect(metadata.stages.model).toMatchObject({ count: 1, failed: 1 });
    expect(metadata.stages.model.wallMs).toBeGreaterThan(5);
    expect(metadata.outcome).toBe('error');
    expect(log[1]).not.toContain('Private provider response');
  });

  it('saves a final answer from lookup evidence with four requests and three tool calls', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: [response(), response(), response(), response('1248 views.')],
    });
    state.resolveLanes.mockReturnValue([lane(model)]);
    const result = await POST(request());
    expect(await result.json()).toMatchObject({
      answer: '1248 views.',
      dropped: 0,
      toolsUsed: ['getPostsRanked', 'getPostsRanked', 'getPostsRanked'],
    });
    expect(state.appendChatTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        question: 'Highest views?',
        answer: '1248 views.',
        validation: null,
      }),
    );
    expect(state.runs).toHaveBeenCalledWith(expect.objectContaining({ calls: 4, status: 'ok' }));
    expect(model.doGenerateCalls.at(-1)?.toolChoice).toEqual({ type: 'none' });
  });

  it.each(['', '99999 views.'])(
    'saves distinct handling and validation for output %j',
    async (text) => {
      state.resolveLanes.mockReturnValue([
        lane(new MockLanguageModelV3({ doGenerate: response(text) })),
      ]);
      const result = await POST(request());
      const body = await result.json();
      expect(body.dropped).toBe(text ? 1 : 0);
      expect(body.answer).toContain(text ? "I've dropped it" : "couldn't generate an answer");
      expect(state.appendChatTurn).toHaveBeenLastCalledWith(
        expect.objectContaining({ validation: text ? { dropped: expect.any(Array) } : null }),
      );
      expect(console.info).toHaveBeenCalledWith(
        '[chat.response]',
        expect.objectContaining({
          emptyBeforeValidation: !text,
          outcome: text ? 'validation_removed' : 'empty_model_response',
        }),
      );
    },
  );

  it('records all attempted primary requests before a quota error and uses the fallback lane', async () => {
    let calls = 0;
    const primary = new MockLanguageModelV3({
      doGenerate: async () => {
        if (++calls < 4) return response();
        throw apiError(429);
      },
    });
    const fallback = new MockLanguageModelV3({
      doGenerate: response('Views were never measured.'),
    });
    state.resolveLanes.mockReturnValue([lane(primary), lane(fallback, 'groq', true)]);
    const result = await POST(request());
    expect(await result.json()).toMatchObject({
      answer: 'Views were never measured.',
      via: 'groq:test',
    });
    expect(state.runs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ provider: 'google', calls: 4, status: 'error' }),
    );
    expect(state.runs).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ provider: 'groq', calls: 1, status: 'ok' }),
    );
    expect(calls).toBe(4);
  });

  it('respects the remaining daily allowance', async () => {
    state.headroom = { allowed: true, used: 79, limit: 80 };
    const model = new MockLanguageModelV3({
      doGenerate: response('I need more evidence to rank your posts.'),
    });
    state.resolveLanes.mockReturnValue([lane(model)]);
    expect((await POST(request())).status).toBe(200);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]?.toolChoice).toEqual({ type: 'none' });
    expect(state.runs).toHaveBeenCalledWith(expect.objectContaining({ calls: 1 }));
  });

  it('preserves the provider-limit response when every lane is exhausted', async () => {
    state.headroom = { allowed: false, used: 80, limit: 80 };
    state.resolveLanes.mockReturnValue([lane(new MockLanguageModelV3())]);
    const result = await POST(request());
    expect(result.status).toBe(429);
    expect(await result.json()).toMatchObject({ error: 'quota' });
    expect(state.runs).not.toHaveBeenCalled();
  });
});

describe('provider failover boundaries', () => {
  it('does not call Groq when Gemini succeeds', async () => {
    const fallback = new MockLanguageModelV3();
    state.resolveLanes.mockReturnValue([
      lane(new MockLanguageModelV3({ doGenerate: response('I could not check views.') })),
      lane(fallback, 'groq', true),
    ]);
    expect((await POST(request())).status).toBe(200);
    expect(fallback.doGenerateCalls).toHaveLength(0);
    expect(state.appendChatTurn).toHaveBeenCalledTimes(1);
  });

  it.each([429, 502, 503, 504, undefined])(
    'fails over on SDK transport status %s',
    async (status) => {
      const primary = new MockLanguageModelV3({
        doGenerate: async () => {
          throw apiError(status);
        },
      });
      const fallback = new MockLanguageModelV3({
        doGenerate: [response(), response('1248 views.')],
      });
      state.resolveLanes.mockReturnValue([lane(primary), lane(fallback, 'groq', true)]);
      const result = await POST(request());
      expect(await result.json()).toMatchObject({
        answer: '1248 views.',
        via: 'groq:test',
        dropped: 0,
      });
      expect(primary.doGenerateCalls).toHaveLength(1);
      expect(fallback.doGenerateCalls).toHaveLength(2);
      expect(fallback.doGenerateCalls[0]?.prompt).toEqual(primary.doGenerateCalls[0]?.prompt);
      expect(state.appendChatTurn).toHaveBeenCalledTimes(1);
      expect(state.runs).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ provider: 'google', calls: 1, status: 'error' }),
      );
      expect(state.runs).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          provider: 'groq',
          calls: 2,
          promptTokens: 20,
          completionTokens: 10,
        }),
      );
    },
  );

  it.each([400, 401, 403, 404, 422, 500])(
    'does not retry or switch on status %s',
    async (status) => {
      const primary = new MockLanguageModelV3({
        doGenerate: async () => {
          throw apiError(status);
        },
      });
      const fallback = new MockLanguageModelV3();
      state.resolveLanes.mockReturnValue([lane(primary), lane(fallback, 'groq', true)]);
      const result = await POST(request());
      expect(result.status).toBe(500);
      expect(JSON.stringify(await result.json())).not.toContain('private provider detail');
      expect(primary.doGenerateCalls).toHaveLength(1);
      expect(fallback.doGenerateCalls).toHaveLength(0);
      expect(state.appendChatTurn).not.toHaveBeenCalled();
    },
  );

  it('does not mistake an application exception for provider overload', async () => {
    const fallback = new MockLanguageModelV3();
    state.resolveLanes.mockReturnValue([
      lane(
        new MockLanguageModelV3({
          doGenerate: async () => {
            throw Object.assign(new Error('quota database failure'), { statusCode: 503 });
          },
        }),
      ),
      lane(fallback, 'groq', true),
    ]);
    expect((await POST(request())).status).toBe(500);
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });

  it('returns a safe outage and saves no partial turn when both providers fail', async () => {
    state.resolveLanes.mockReturnValue(
      ['google', 'groq'].map((provider) =>
        lane(
          new MockLanguageModelV3({
            doGenerate: async () => {
              throw apiError(503);
            },
          }),
          provider,
          provider === 'groq',
        ),
      ),
    );
    const result = await POST(request());
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      error: 'model_unavailable',
      message: 'Chat is temporarily busy. Please try again later.',
    });
    expect(state.appendChatTurn).not.toHaveBeenCalled();
    expect(state.runs).toHaveBeenCalledTimes(2);
    // Retrying the same question commits one turn, not the failed attempts.
    state.resolveLanes.mockReturnValue([
      lane(new MockLanguageModelV3({ doGenerate: response('Please choose a measure.') })),
    ]);
    expect((await POST(request())).status).toBe(200);
    expect(state.appendChatTurn).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported figures from Groq with the existing validator', async () => {
    state.resolveLanes.mockReturnValue([
      lane(
        new MockLanguageModelV3({
          doGenerate: async () => {
            throw apiError(503);
          },
        }),
      ),
      lane(
        new MockLanguageModelV3({ doGenerate: [response(), response('99999 views.')] }),
        'groq',
        true,
      ),
    ]);
    const body = await (await POST(request())).json();
    expect(body.dropped).toBe(1);
    expect(body.answer).not.toContain('99999');
    expect(state.appendChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ validation: { dropped: expect.any(Array) } }),
    );
  });

  it('does not classify persistence errors as provider errors or switch lanes', async () => {
    state.appendChatTurn.mockRejectedValueOnce(new Error('private database detail'));
    const fallback = new MockLanguageModelV3();
    state.resolveLanes.mockReturnValue([
      lane(new MockLanguageModelV3({ doGenerate: response('Please choose a measure.') })),
      lane(fallback, 'groq', true),
    ]);
    const result = await POST(request());
    expect(result.status).toBe(500);
    expect(JSON.stringify(await result.json())).not.toContain('private database detail');
    expect(fallback.doGenerateCalls).toHaveLength(0);
    expect(state.runs).toHaveBeenCalledTimes(1);
  });
});

it('stops on tool failure without a second model request or provider switch', async () => {
  state.execute.mockRejectedValueOnce(new Error('private database failure'));
  const primary = new MockLanguageModelV3({ doGenerate: response() });
  const fallback = new MockLanguageModelV3();
  state.resolveLanes.mockReturnValue([lane(primary), lane(fallback, 'groq', true)]);
  const result = await POST(request());
  expect(result.status).toBe(500);
  expect(primary.doGenerateCalls).toHaveLength(1);
  expect(fallback.doGenerateCalls).toHaveLength(0);
  expect(state.appendChatTurn).not.toHaveBeenCalled();
  expect(state.runs).toHaveBeenCalledWith(
    expect.objectContaining({ calls: 1, error: 'application' }),
  );
});

it('checks Groq independently when the Gemini request guard refuses', async () => {
  state.checkHeadroom.mockImplementation(async (_purpose, ledger) =>
    ledger.provider === 'google'
      ? { allowed: false, used: 80, limit: 80, retryAfterSeconds: 60 }
      : { allowed: true, used: 0, limit: 80 },
  );
  const primary = new MockLanguageModelV3();
  const fallback = new MockLanguageModelV3({ doGenerate: response('Please choose a measure.') });
  state.resolveLanes.mockReturnValue([lane(primary), lane(fallback, 'groq', true)]);
  expect((await POST(request())).status).toBe(200);
  expect(primary.doGenerateCalls).toHaveLength(0);
  expect(fallback.doGenerateCalls).toHaveLength(1);
  expect(state.runs).toHaveBeenCalledTimes(1);
  expect(state.runs).toHaveBeenCalledWith(expect.objectContaining({ provider: 'groq' }));
});

it('returns a safe wait after both providers return 429 without saving a partial turn', async () => {
  state.resolveLanes.mockReturnValue(
    ['google', 'groq'].map((provider) =>
      lane(
        new MockLanguageModelV3({
          doGenerate: async () => {
            throw apiError(429);
          },
        }),
        provider,
        provider === 'groq',
      ),
    ),
  );
  const result = await POST(request());
  expect(result.status).toBe(429);
  expect(result.headers.get('retry-after')).toBe('60');
  expect(await result.json()).toMatchObject({ error: 'quota', retryAfterSeconds: 60 });
  expect(state.appendChatTurn).not.toHaveBeenCalled();
  expect(state.runs).toHaveBeenCalledTimes(2);
});

describe('merged performance instrumentation and persistence accounting', () => {
  const id = '12345678-1234-4234-8234-123456789abc';
  const correlatedRequest = () =>
    new Request(request(), { headers: { 'x-trellis-request-id': id } });
  const timing = () => {
    const entry = vi.mocked(console.info).mock.calls.find(([label]) => label === '[performance]');
    return JSON.parse(String(entry?.[1]));
  };

  it('keeps correlation, model/tool timing, and counters across a provider switch', async () => {
    vi.stubEnv('TRELLIS_PERFORMANCE', '1');
    state.resolveLanes.mockReturnValue([
      lane(
        new MockLanguageModelV3({
          doGenerate: async () => {
            throw apiError(503);
          },
        }),
      ),
      lane(
        new MockLanguageModelV3({ doGenerate: [response(), response('1248 views.')] }),
        'groq',
        true,
      ),
    ]);
    const result = await POST(correlatedRequest());
    expect(result.status).toBe(200);
    expect(result.headers.get('x-trellis-request-id')).toBe(id);
    expect(result.headers.get('server-timing')).toContain('model;dur=');
    expect(timing()).toMatchObject({
      requestId: id,
      outcome: 'ok',
      counters: { historyMessages: 1, modelCalls: 3, inputTokens: 20, outputTokens: 10 },
      stages: {
        preflight: { count: 1 },
        model: { count: 3, failed: 1 },
        tool: { count: 1, failed: 0 },
        validation: { count: 1 },
        persistence: { count: 3, failed: 0 },
      },
    });
    expect(console.info).toHaveBeenCalledWith(
      '[chat.response]',
      expect.objectContaining({ requestId: id, provider: 'groq' }),
    );
    expect(JSON.stringify(timing())).not.toContain('Highest views?');
  });

  it('counts successful generation before failed turn persistence and distinguishes its outcome', async () => {
    vi.stubEnv('TRELLIS_PERFORMANCE', '1');
    state.appendChatTurn.mockRejectedValueOnce(new Error('private persistence error'));
    const fallback = new MockLanguageModelV3();
    state.resolveLanes.mockReturnValue([
      lane(new MockLanguageModelV3({ doGenerate: [response(), response('1248 views.')] })),
      lane(fallback, 'groq', true),
    ]);
    const result = await POST(correlatedRequest());
    expect(result.status).toBe(500);
    expect(await result.json()).toMatchObject({ error: 'chat_persistence_failed' });
    expect(state.runs).toHaveBeenCalledTimes(1);
    expect(state.runs).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'google',
        status: 'ok',
        calls: 2,
        promptTokens: 20,
        completionTokens: 10,
      }),
    );
    expect(state.runs.mock.invocationCallOrder[0]).toBeLessThan(
      state.appendChatTurn.mock.invocationCallOrder[0]!,
    );
    expect(fallback.doGenerateCalls).toHaveLength(0);
    expect(console.info).toHaveBeenCalledWith(
      '[chat.persistence]',
      expect.objectContaining({
        requestId: id,
        generationOutcome: 'ok',
        persistenceOutcome: 'error',
      }),
    );
    expect(timing()).toMatchObject({
      requestId: id,
      outcome: 'error',
      stages: { model: { count: 2, failed: 0 }, persistence: { count: 2, failed: 1 } },
    });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(
      'private persistence error',
    );
  });

  it('does not call another provider or save the turn if the usage ledger cannot be written', async () => {
    state.runs.mockRejectedValueOnce(new Error('private ledger detail'));
    const fallback = new MockLanguageModelV3();
    state.resolveLanes.mockReturnValue([
      lane(new MockLanguageModelV3({ doGenerate: response('Choose a measure.') })),
      lane(fallback, 'groq', true),
    ]);
    const result = await POST(request());
    expect(result.status).toBe(500);
    expect(JSON.stringify(await result.json())).not.toContain('private ledger detail');
    expect(state.runs).toHaveBeenCalledTimes(1);
    expect(state.appendChatTurn).not.toHaveBeenCalled();
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });
});
