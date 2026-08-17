import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { env } from '../../env';

/**
 * Streaming chat needs a raw AI SDK model object (for tool-loop streaming),
 * not the one-shot `complete()` wrapper the rest of the app uses — different
 * shape of problem, same provider underneath.
 */

let override: LanguageModel | null = null;

/** Test seam: swap in an `ai/test` MockLanguageModel without touching the environment. */
export function __setChatModelForTests(model: LanguageModel | null): void {
  override = model;
}

export function getChatModel(): { model: LanguageModel; generatedBy: string } {
  if (override) return { model: override, generatedBy: 'fake:mock' };
  const e = env();
  const google = createGoogleGenerativeAI({ apiKey: e.GOOGLE_GENERATIVE_AI_API_KEY ?? '' });
  return { model: google(e.GOOGLE_MODEL), generatedBy: `google:${e.GOOGLE_MODEL}` };
}
