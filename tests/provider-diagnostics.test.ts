import { afterEach, describe, expect, it, vi } from 'vitest';
import { APICallError, UnsupportedFunctionalityError } from 'ai';
import {
  diagnosticFetch,
  safeException,
  withProviderAttempt,
  type ProviderAttempt,
} from '../lib/model/diagnostics';

afterEach(() => vi.unstubAllGlobals());
describe('bounded provider diagnostics', () => {
  it('does not export arbitrary names, messages, causes or provider payloads', () => {
    const error = Object.assign(new Error('private prompt'), {
      name: 'private-key',
      statusCode: 403,
      responseBody: 'private result',
    });
    expect(safeException(error)).toEqual({
      exceptionName: 'UnknownError',
      sdkErrorCode: undefined,
      httpStatus: undefined,
    });
    expect(
      safeException(new UnsupportedFunctionalityError({ functionality: 'private schema' })),
    ).toMatchObject({ sdkErrorCode: 'AI_UnsupportedFunctionalityError' });
    const transport = new APICallError({
      message: 'secret',
      url: 'secret',
      requestBodyValues: 'secret',
      responseBody: 'secret',
      statusCode: 503,
    });
    expect(JSON.stringify(safeException(transport))).not.toContain('secret');
    expect(safeException(transport).httpStatus).toBe(503);
  });
  it('tracks transport invocation in isolated attempts without reading payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ private: true }, { status: 503 })),
    );
    const sent: ProviderAttempt = { stage: 'provider_preparation', httpRequestAttempted: false };
    const unsent: ProviderAttempt = { stage: 'provider_preparation', httpRequestAttempted: false };
    await Promise.all([
      withProviderAttempt(sent, () => diagnosticFetch('https://example.test')),
      withProviderAttempt(unsent, async () => {}),
    ]);
    expect(sent).toEqual({
      stage: 'provider_response',
      httpRequestAttempted: true,
      httpStatus: 503,
    });
    expect(unsent.httpRequestAttempted).toBe(false);
  });
});
