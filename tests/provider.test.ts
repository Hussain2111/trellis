import { describe, expect, it } from 'vitest';
import { APICallError } from 'ai';
import {
  asQuotaError,
  checkHeadroom,
  knownProviders,
  maxStepsFor,
  parseModelRef,
  questionsLeft,
  resolveLanes,
  type QuotaLedger,
} from '../lib/model/provider';
import { __setEnvForTests } from '../lib/env';

describe('parseModelRef', () => {
  it('splits provider from model', () => {
    expect(parseModelRef('google:gemini-3.6-flash')).toEqual({
      provider: 'google',
      modelId: 'gemini-3.6-flash',
    });
  });

  it('keeps colons inside a model id', () => {
    expect(parseModelRef('openrouter:meta-llama/llama-3.1:free')).toEqual({
      provider: 'openrouter',
      modelId: 'meta-llama/llama-3.1:free',
    });
  });

  it('refuses a bare model name', () => {
    expect(() => parseModelRef('gemini-3.6-flash')).toThrow(/provider:model/);
  });
});

const ledger = (chat: number, cards: number, lastMinute = 0): QuotaLedger => ({
  callsToday: async (purpose) => (purpose === 'chat' ? chat : cards),
  callsLastMinute: async () => lastMinute,
});

const caps = { dailyCalls: 100, reservedForCards: 20, callsPerMinute: 60 };

describe('quota rationing', () => {
  it('counts calls, not messages', async () => {
    // Six calls is one chat message with a tool loop, not six messages. A cap
    // read as messages-per-day is several times looser than it looks.
    const headroom = await checkHeadroom('chat', ledger(6, 0), caps);
    expect(headroom.used).toBe(6);
  });

  it('holds back the card reservation from chat', async () => {
    expect((await checkHeadroom('chat', ledger(79, 0), caps)).allowed).toBe(true);
    expect((await checkHeadroom('chat', ledger(80, 0), caps)).allowed).toBe(false);
  });

  it('does not let heavy chat use starve scheduled generation', async () => {
    const headroom = await checkHeadroom('cards', ledger(80, 0), caps);
    expect(headroom.allowed).toBe(true);
  });

  it('refuses cards once the whole day is spent', async () => {
    expect((await checkHeadroom('cards', ledger(0, 100), caps)).allowed).toBe(false);
  });

  it('explains a refusal rather than degrading silently', async () => {
    const headroom = await checkHeadroom('chat', ledger(80, 0), caps);
    expect(headroom.reason).toMatch(/held for the dashboard notes/);
  });
});

/**
 * The limit that actually fired, in production, on the free tier.
 *
 * `Quota exceeded ... limit: 5, model: gemini-3.6-flash` — five requests a
 * MINUTE, against a daily cap of two hundred that was nowhere near spent. A
 * guard that only knows about the day never sees this coming, and the tool loop
 * inside one chat message can spend it without the loop ever returning.
 */
describe('the per-minute limit', () => {
  const free = { dailyCalls: 200, reservedForCards: 40, callsPerMinute: 5 };

  it('keeps one message’s tool loop under the per-minute ceiling', () => {
    // Four steps is four requests, against five a minute, leaving one so a
    // follow-up question does not have to wait out the whole window.
    expect(maxStepsFor(free)).toBe(4);
  });

  it('never drops below a usable loop, however tight the plan', () => {
    expect(maxStepsFor({ ...free, callsPerMinute: 1 })).toBe(2);
  });

  it('does not start a turn it cannot finish inside the limit', async () => {
    const headroom = await checkHeadroom('chat', ledger(0, 0, 2), free);
    expect(headroom.allowed).toBe(false);
    expect(headroom.retryAfterSeconds).toBe(60);
    expect(headroom.reason).toMatch(/5 requests a minute/);
  });

  it('allows a turn that fits', async () => {
    expect((await checkHeadroom('chat', ledger(0, 0, 1), free)).allowed).toBe(true);
  });

  it('is checked before the daily cap, because it clears on its own', async () => {
    // Both are exceeded. The per-minute one is the actionable message: wait a
    // minute, rather than come back tomorrow.
    const headroom = await checkHeadroom('chat', ledger(500, 0, 5), free);
    expect(headroom.retryAfterSeconds).toBe(60);
  });
});

describe('telling a quota error from a broken provider', () => {
  it('reads the wait out of the provider’s own message', () => {
    const quota = asQuotaError(
      new Error(
        'You exceeded your current quota. Quota exceeded for metric: ' +
          'generativelanguage.googleapis.com/generate_content_free_tier_requests, ' +
          'limit: 5, model: gemini-3.6-flash Please retry in 12.174274113s.',
      ),
    );
    expect(quota?.retryAfterSeconds).toBe(13);
  });

  it('falls back to a minute when the provider does not say', () => {
    expect(
      asQuotaError(Object.assign(new Error('Too Many Requests'), { statusCode: 429 }))
        ?.retryAfterSeconds,
    ).toBe(60);
  });

  it('does not treat a real failure as a quota error', () => {
    // These clear differently — one by waiting, one not at all — so they must
    // not produce the same response.
    expect(asQuotaError(new Error('fetch failed'))).toBeNull();
    expect(asQuotaError(new Error('model not found'))).toBeNull();
  });
});

/**
 * Twenty requests a day is the binding constraint on this whole product.
 *
 * `[VERIFIED-LIVE]` 2026-08-27, AI Studio: RPD 20 for gemini-3.6-flash on the
 * free tier, against a 28-day peak of 44. The previous default of 200 was
 * invented before the number was known and would not have stopped anything.
 */
describe('the daily limit, at its real size', () => {
  const free = { dailyCalls: 20, reservedForCards: 4, callsPerMinute: 5 };

  it('is about four questions a day, not two hundred', () => {
    // 20 total, 4 held for the dashboard notes, 4 requests per question.
    expect(questionsLeft(0, free)).toBe(4);
  });

  it('counts down as the day is spent', () => {
    expect(questionsLeft(4, free)).toBe(3);
    expect(questionsLeft(12, free)).toBe(1);
    expect(questionsLeft(16, free)).toBe(0);
  });

  it('never promises a question it cannot afford', () => {
    // Three requests left is not a question when a question can cost four.
    expect(questionsLeft(13, free)).toBe(0);
  });

  it('says when the next slot frees rather than "come back tomorrow"', async () => {
    // The window is rolling, so it frees gradually. An oldest call twenty hours
    // ago means roughly four hours until the first slot returns.
    const twentyHoursAgo = new Date(Date.now() - 20 * 3_600_000);
    const headroom = await checkHeadroom(
      'chat',
      {
        callsToday: async (purpose) => (purpose === 'chat' ? 16 : 0),
        callsLastMinute: async () => 0,
        oldestCallInWindow: async () => twentyHoursAgo,
      },
      free,
    );

    expect(headroom.allowed).toBe(false);
    expect(headroom.retryAfterSeconds).toBeGreaterThan(3 * 3600);
    expect(headroom.retryAfterSeconds).toBeLessThan(5 * 3600);
    expect(headroom.reason).toMatch(/20 requests are spent/);
  });

  it('refuses without a time when it has never made a call', async () => {
    const headroom = await checkHeadroom(
      'chat',
      {
        callsToday: async (purpose) => (purpose === 'chat' ? 16 : 0),
        callsLastMinute: async () => 0,
        oldestCallInWindow: async () => null,
      },
      free,
    );
    expect(headroom.allowed).toBe(false);
    expect(headroom.retryAfterSeconds).toBeUndefined();
  });
});

/**
 * Switching provider has to be an environment change, or it will not happen
 * when it needs to — which is at the moment the current one stops answering.
 */
describe('lanes', () => {
  const withEnv = <T>(vars: Record<string, string>, run: () => T): T => {
    const saved = { ...process.env };
    Object.assign(process.env, vars);
    __setEnvForTests(null);
    try {
      return run();
    } finally {
      for (const key of Object.keys(vars)) delete process.env[key];
      Object.assign(process.env, saved);
      __setEnvForTests(null);
    }
  };

  it('reaches more than one provider without a code change', () => {
    expect(knownProviders()).toEqual(
      expect.arrayContaining(['google', 'groq', 'deepseek', 'openrouter']),
    );
  });

  it('builds a lane from an OpenAI-compatible provider and its key', () => {
    withEnv({ MODEL_PRIMARY: 'groq:llama-3.3-70b-versatile', GROQ_API_KEY: 'k' }, () => {
      const [lane] = resolveLanes();
      expect(lane?.provider).toBe('groq');
      expect(lane?.modelId).toBe('llama-3.3-70b-versatile');
      expect(lane?.isFallback).toBe(false);
    });
  });

  it('offers the fallback as a second lane, not only when the first is unbuildable', () => {
    withEnv(
      {
        MODEL_PRIMARY: 'google:gemini-3.6-flash',
        GOOGLE_GENERATIVE_AI_API_KEY: 'k',
        MODEL_FALLBACK: 'groq:llama-3.3-70b-versatile',
        GROQ_API_KEY: 'k',
      },
      () => {
        const lanes = resolveLanes();
        expect(lanes.map((lane) => lane.provider)).toEqual(['google', 'groq']);
        expect(lanes[1]?.isFallback).toBe(true);
      },
    );
  });

  it('drops a same-provider fallback, which shares the exhausted limit', () => {
    // A rate limit is per project, not per model. A second Gemini model is out
    // of requests for exactly the same reason the first one is.
    withEnv(
      {
        MODEL_PRIMARY: 'google:gemini-3.6-flash',
        MODEL_FALLBACK: 'google:gemini-3.6-pro',
        GOOGLE_GENERATIVE_AI_API_KEY: 'k',
      },
      () => {
        expect(resolveLanes()).toHaveLength(1);
      },
    );
  });

  it('still serves the primary when the fallback has no key', () => {
    withEnv(
      {
        MODEL_PRIMARY: 'google:gemini-3.6-flash',
        GOOGLE_GENERATIVE_AI_API_KEY: 'k',
        MODEL_FALLBACK: 'groq:llama-3.3-70b-versatile',
      },
      () => {
        expect(resolveLanes().map((lane) => lane.provider)).toEqual(['google']);
      },
    );
  });

  it('names what it knows when asked for a provider it does not', () => {
    withEnv(
      {
        MODEL_PRIMARY: 'anthropic:claude',
        MODEL_FALLBACK: 'groq:openai/gpt-oss-120b',
        GROQ_API_KEY: 'test-only',
      },
      () => {
        expect(() => resolveLanes()).toThrow(/Known: /);
      },
    );
  });
});

describe('independent Groq request caps', () => {
  it('overrides Groq without changing Gemini or the conservative defaults', async () => {
    const { quotaCaps } = await import('../lib/model/provider');
    __setEnvForTests({
      MODEL_CALLS_PER_MINUTE: 5,
      MODEL_CALLS_PER_DAY: 20,
      GROQ_CALLS_PER_MINUTE: 12,
      GROQ_CALLS_PER_DAY: 80,
    });
    try {
      expect(quotaCaps('google')).toEqual({
        callsPerMinute: 5,
        dailyCalls: 20,
        reservedForCards: 4,
      });
      expect(quotaCaps('groq')).toEqual({
        callsPerMinute: 12,
        dailyCalls: 80,
        reservedForCards: 16,
      });
    } finally {
      __setEnvForTests(null);
    }
  });
});

it('honors transport Retry-After over text and never treats authentication as quota', () => {
  const error = (statusCode: number) =>
    new APICallError({
      message: 'quota detail retry in 1s',
      url: 'https://example.test',
      requestBodyValues: {},
      statusCode,
      responseHeaders: { 'retry-after': '120' },
    });
  expect(asQuotaError(error(429))?.retryAfterSeconds).toBe(120);
  expect(asQuotaError(error(401))).toBeNull();
  expect(asQuotaError(error(503))).toBeNull();
});
