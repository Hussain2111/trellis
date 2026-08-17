import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { dropTempDb, setEnv, useTempDb } from './helpers';
import { assertProviderAllowed, PaidProviderError } from '@/lib/providers/guard';
import {
  __setProvidersForTests,
  complete,
  extractJson,
  FakeLlm,
  TierBPromptTooLarge,
} from '@/lib/providers/llm';
import { estimateTokens } from '@/lib/providers/llm/tokens';
import { checkHeadroom, consume, markDailyExhausted, classifyQuotaError } from '@/lib/quota/budget';
import { monthlyCostSummary, recentRuns } from '@/lib/runs/log';

beforeAll(() => useTempDb());
afterAll(() => dropTempDb());
beforeEach(() => setEnv());

describe('paid-provider guard', () => {
  const paid = {
    id: 'expensive-thing',
    kind: 'llm' as const,
    costsMoney: true,
    costNote: 'bills per token',
  };

  it('throws by default, naming the provider', () => {
    process.env.ALLOW_PAID_PROVIDERS = 'false';
    expect(() => assertProviderAllowed(paid)).toThrow(PaidProviderError);
    try {
      assertProviderAllowed(paid);
    } catch (error) {
      expect((error as Error).message).toContain('expensive-thing');
    }
  });

  it('never blocks a free provider', () => {
    process.env.ALLOW_PAID_PROVIDERS = 'false';
    expect(() => assertProviderAllowed({ ...paid, costsMoney: false })).not.toThrow();
  });

  it('allows a paid provider only when explicitly opted in', () => {
    process.env.ALLOW_PAID_PROVIDERS = 'true';
    expect(() => assertProviderAllowed(paid)).not.toThrow();
    process.env.ALLOW_PAID_PROVIDERS = 'false';
  });
});

describe('tier B prompt ceiling', () => {
  it('throws rather than spending minutes in prefill', async () => {
    setEnv({ TIER_B_MAX_PROMPT_TOKENS: '100' });
    __setProvidersForTests({ tierB: new FakeLlm({ tier: 'B' }) });

    await expect(
      complete({ tier: 'B', operation: 'misc', prompt: 'word '.repeat(500) }),
    ).rejects.toThrow(TierBPromptTooLarge);
  });

  it('lets a short prompt through', async () => {
    setEnv({ TIER_B_MAX_PROMPT_TOKENS: '800' });
    __setProvidersForTests({ tierB: new FakeLlm({ tier: 'B', model: 'fake-local' }) });

    const result = await complete({ tier: 'B', operation: 'misc', prompt: 'Name this cluster.' });
    expect(result.tier).toBe('B');
    expect(result.generatedBy).toBe('fake:fake-local');
  });

  it('estimates tokens conservatively', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
    expect(estimateTokens('a'.repeat(4000))).toBeGreaterThanOrEqual(1000);
  });
});

describe('router', () => {
  beforeEach(() => {
    setEnv();
    __setProvidersForTests({ tierA: null, tierB: null, embedder: null });
  });

  it('parses and validates structured output', async () => {
    const schema = z.object({ name: z.string(), score: z.number() });
    const tierA = new FakeLlm({ tier: 'A' });
    tierA.queue('```json\n{"name":"secret settings","score":51}\n```');
    __setProvidersForTests({ tierA });

    const result = await complete({
      tier: 'A',
      operation: 'cluster_naming',
      prompt: 'name it',
      schema,
    });
    expect(result.value).toEqual({ name: 'secret settings', score: 51 });
  });

  it('repairs one bad structured response, then succeeds', async () => {
    const schema = z.object({ name: z.string() });
    const tierA = new FakeLlm({ tier: 'A' });
    tierA.queue('sorry, I cannot do that', '{"name":"fixed"}');
    __setProvidersForTests({ tierA });

    const result = await complete({ tier: 'A', operation: 'misc', prompt: 'name it', schema });
    expect(result.value).toEqual({ name: 'fixed' });
    expect(tierA.calls).toHaveLength(2);
    expect(tierA.calls[1]!.prompt).toContain('did not validate');
  });

  it('gives up after one repair rather than burning quota', async () => {
    const schema = z.object({ name: z.string() });
    const tierA = new FakeLlm({ tier: 'A' });
    tierA.queue('nope', 'still nope');
    __setProvidersForTests({ tierA });

    await expect(
      complete({ tier: 'A', operation: 'misc', prompt: 'name it', schema }),
    ).rejects.toThrow(/failed schema validation twice/);
  });

  it('falls back A → B when the day is spent, and flags the result degraded', async () => {
    const tierA = new FakeLlm({ tier: 'A', id: 'google' });
    const tierB = new FakeLlm({ tier: 'B', id: 'ollama', model: 'local-4b' });
    __setProvidersForTests({ tierA, tierB });

    markDailyExhausted('google');
    const result = await complete({ tier: 'A', operation: 'chat', prompt: 'hello' });

    expect(result.degraded).toBe(true);
    expect(result.tier).toBe('B');
    expect(result.generatedBy).toBe('ollama:local-4b');
    expect(tierA.calls).toHaveLength(0);
  });

  it('refuses to degrade silently when fallback is disallowed', async () => {
    __setProvidersForTests({
      tierA: new FakeLlm({ tier: 'A', id: 'google' }),
      tierB: new FakeLlm({ tier: 'B', id: 'ollama' }),
    });
    markDailyExhausted('google');

    await expect(
      complete({ tier: 'A', operation: 'chat', prompt: 'hello', allowFallback: false }),
    ).rejects.toThrow(/daily free-tier allowance/);
  });

  it('logs every call to runs, and the month totals $0.00', async () => {
    // A fresh provider id: the fallback tests above deliberately left "google"
    // marked as exhausted for the rest of the day.
    __setProvidersForTests({ tierA: new FakeLlm({ tier: 'A', id: 'google-fresh' }) });
    await complete({ tier: 'A', operation: 'gap_analysis', prompt: 'go' });

    const runs = recentRuns(5);
    expect(runs[0]?.operation).toBe('gap_analysis');
    expect(runs[0]?.status).toBe('ok');
    expect(monthlyCostSummary().monthToDateUsd).toBe(0);
  });
});

describe('json extraction', () => {
  it('survives fences, prose, and trailing chatter', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('Sure! {"a":1} Hope that helps.')).toBe('{"a":1}');
    expect(extractJson('[{"a":1},{"b":2}]')).toBe('[{"a":1},{"b":2}]');
    expect(extractJson('{"a":"} not the end"}')).toBe('{"a":"} not the end"}');
    expect(extractJson('no json here')).toBeNull();
  });
});

describe('quota budget', () => {
  it('spends down a daily allowance', () => {
    const before = checkHeadroom('test-provider', 'gap_analysis');
    expect(before.allowed).toBe(true);
    consume('test-provider', 'gap_analysis', before.allowance);
    expect(checkHeadroom('test-provider', 'gap_analysis').allowed).toBe(false);
  });

  it('distinguishes a per-minute limit from a spent day', () => {
    expect(classifyQuotaError(new Error('boom')).kind).toBe('none');
    expect(classifyQuotaError(new Error('429 rate limit exceeded')).kind).toBe('per_minute');
    expect(classifyQuotaError(new Error('429 quota exceeded: requests per day')).kind).toBe('daily');
    expect(classifyQuotaError(new Error('429, retry-after: 7200')).kind).toBe('daily');
    expect(classifyQuotaError(new Error('429 rate limit, retry-after: 30')).retryAfterS).toBe(30);
  });
});
