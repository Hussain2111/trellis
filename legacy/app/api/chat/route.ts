import { convertToModelMessages, streamText, stepCountIs, type UIMessage } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOllama } from 'ollama-ai-provider-v2';
import { z } from 'zod';
import { env } from '@/lib/env';
import { coachTools } from '@/lib/chat/tools';
import { appendMessage, buildSystemPrompt, titleThread, threadMessages } from '@/lib/chat/threads';
import { checkHeadroom, consume } from '@/lib/quota/budget';
import { recordRun } from '@/lib/runs/log';
import { getSettings } from '@/lib/settings';

export const maxDuration = 300;

const bodySchema = z.object({
  threadId: z.number().int(),
  messages: z.array(z.unknown()),
});

/**
 * Streaming chat. This route talks to the provider SDKs directly rather than
 * going through `llm.complete`, because the router is built for one-shot
 * structured calls and streaming with tool loops is a different shape.
 *
 * Quota handling is explicit here: chat is the first job type to yield when the
 * day runs short, and falling back to a local model for chat is genuinely slow
 * (the system prompt alone is long), so the client is told rather than left
 * waiting.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: 'bad request' }, { status: 400 });
  }

  const { threadId, messages } = parsed.data;
  const uiMessages = messages as UIMessage[];
  const e = env();
  const settings = getSettings();

  const last = uiMessages.at(-1);
  const lastText =
    last?.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join(' ') ?? '';

  if (lastText) {
    appendMessage({ threadId, role: 'user', content: lastText });
    if (threadMessages(threadId).length === 1) titleThread(threadId, lastText);
  }

  const localOnly = settings.localOnlyVoiceAndChat;
  const headroom = checkHeadroom('google', 'chat');
  const useLocal = localOnly || !headroom.allowed;

  if (useLocal && !e.OLLAMA_MODEL) {
    return Response.json(
      {
        error: 'quota_exhausted',
        message: localOnly
          ? 'Chat is set to local-only, but no local model is configured. Run `npm run bench:llm` and set OLLAMA_MODEL.'
          : `Tier A chat allowance is spent for today (resets ${new Date(headroom.resetAt * 1000).toLocaleTimeString()}), and there is no local model configured to fall back to.`,
      },
      { status: 429 },
    );
  }

  const model = useLocal
    ? createOllama({ baseURL: `${e.OLLAMA_BASE_URL}/api` })(e.OLLAMA_MODEL)
    : createGoogleGenerativeAI({ apiKey: e.GOOGLE_GENERATIVE_AI_API_KEY ?? '' })(e.GOOGLE_MODEL);

  const generatedBy = useLocal ? `ollama:${e.OLLAMA_MODEL}` : `google:${e.GOOGLE_MODEL}`;
  const started = Date.now();

  if (!useLocal) consume('google', 'chat');

  const result = streamText({
    model,
    system: buildSystemPrompt(),
    messages: await convertToModelMessages(uiMessages),
    tools: coachTools(),
    // Tool loops need room, but not unbounded room — a runaway loop on a
    // rationed free tier is expensive in the only currency this app has.
    stopWhen: stepCountIs(8),
    temperature: 0.6,
    onFinish: ({ text, usage }) => {
      if (text.trim()) {
        appendMessage({ threadId, role: 'assistant', content: text, generatedBy });
      }
      recordRun({
        provider: useLocal ? 'ollama' : 'google',
        model: useLocal ? e.OLLAMA_MODEL : e.GOOGLE_MODEL,
        operation: 'chat',
        tier: useLocal ? 'B' : 'A',
        status: 'ok',
        promptTokens: usage?.inputTokens ?? null,
        completionTokens: usage?.outputTokens ?? null,
        durationMs: Date.now() - started,
        meta: useLocal && !localOnly ? { degraded: true } : null,
      });
    },
    onError: ({ error }) => {
      recordRun({
        provider: useLocal ? 'ollama' : 'google',
        operation: 'chat',
        tier: useLocal ? 'B' : 'A',
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      });
    },
  });

  return result.toUIMessageStreamResponse({
    headers: { 'x-generated-by': generatedBy, 'x-degraded': String(useLocal && !localOnly) },
  });
}
