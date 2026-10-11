import { AsyncLocalStorage } from 'node:async_hooks';
import { APICallError, AISDKError } from 'ai';

export type FailureStage =
  'provider_preparation' | 'provider_transport' | 'provider_response' | 'tool_execution';
export interface ProviderAttempt {
  stage: FailureStage;
  httpRequestAttempted: boolean;
  httpStatus?: number;
}
const attempts = new AsyncLocalStorage<ProviderAttempt>();
export const withProviderAttempt = <T>(attempt: ProviderAttempt, work: () => Promise<T>) =>
  attempts.run(attempt, work);

/** Observe transport invocation only; never inspect URLs, headers, bodies or responses. */
export const diagnosticFetch: typeof fetch = async (input, init) => {
  const attempt = attempts.getStore();
  if (attempt) {
    attempt.httpRequestAttempted = true;
    attempt.stage = 'provider_transport';
  }
  const response = await globalThis.fetch(input, init);
  if (attempt) {
    attempt.httpStatus = response.status;
    attempt.stage = 'provider_response';
  }
  return response;
};

const SDK_NAMES = new Set([
  'AI_APICallError',
  'AI_UnsupportedFunctionalityError',
  'AI_InvalidPromptError',
  'AI_InvalidArgumentError',
  'AI_InvalidResponseDataError',
  'AI_JSONParseError',
  'AI_TypeValidationError',
  'AI_LoadAPIKeyError',
  'AI_LoadSettingError',
  'AI_NoSuchModelError',
  'AI_UnsupportedModelVersionError',
  'AI_InvalidToolInputError',
  'AI_NoSuchToolError',
  'AI_MissingToolResultsError',
  'AI_NoOutputGeneratedError',
  'AI_InvalidMessageRoleError',
  'AI_MessageConversionError',
  'AI_InvalidDataContentError',
  'AI_EmptyResponseBodyError',
  'AI_RetryError',
]);
const BASIC_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError']);

/** No messages, causes, provider payloads or arbitrary exception properties are exported. */
export function safeException(error: unknown) {
  const sdkErrorCode =
    AISDKError.isInstance(error) && SDK_NAMES.has(error.name) ? error.name : undefined;
  return {
    exceptionName:
      sdkErrorCode ??
      (error instanceof Error && BASIC_NAMES.has(error.name) ? error.name : 'UnknownError'),
    sdkErrorCode,
    httpStatus: APICallError.isInstance(error) ? error.statusCode : undefined,
  };
}
