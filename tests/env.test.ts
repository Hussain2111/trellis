import { describe, expect, it } from 'vitest';
import { envSchema } from '../lib/env';

describe('envSchema', () => {
  it('parses an empty environment with safe defaults', () => {
    const result = envSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.ALLOW_PAID_PROVIDERS).toBe(false);
    expect(result.data.LLM_PROVIDER).toBe('google');
    expect(result.data.SCRAPE_MODE).toBe('fixture');
  });

  it('coerces string booleans for ALLOW_PAID_PROVIDERS', () => {
    const result = envSchema.safeParse({ ALLOW_PAID_PROVIDERS: 'true' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.ALLOW_PAID_PROVIDERS).toBe(true);
  });

  it('defaults ALLOW_PAID_PROVIDERS to false for any falsy-looking string', () => {
    const result = envSchema.safeParse({ ALLOW_PAID_PROVIDERS: 'nope' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.ALLOW_PAID_PROVIDERS).toBe(false);
  });
});
