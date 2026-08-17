import { convertToModelMessages, streamText, stepCountIs, type UIMessage } from 'ai';
import { z } from 'zod';
import { coachTools } from '@/lib/chat/tools';
import { appendMessage, buildSystemPrompt, titleThread, threadMessages } from '@/lib/chat/threads';
import { checkHeadroom, consume } from '@/lib/quota/budget';
import { recordRun } from '@/lib/runs/log';
import { getChatModel } from '@/lib/providers/llm/chat-model';

export const maxDuration = 60;

const bodySchema = z.object({
  threadId: z.number().int(),
  messages: z.array(z.unknown()),
});

/**
 * Streaming chat. Talks to the provider SDK directly rather than going
 * through `lib/providers/llm`'s one-shot `complete()`, since streaming with
 * a tool loop is a different shape of problem. There is only one tier
 * (Gemini free) — no local fallback exists in a serverless deployment, so
 * quota exhaustion is a clear 429 telling the user when it resets, not a
 * silent degrade.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: 'bad request' }, { status: 400 });
  }

  const { threadId, messages } = parsed.data;
  const uiMessages = messages as UIMessage[];

  const last = uiMessages.at(-1);
  const lastText =
    last?.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join(' ') ?? '';

  if (lastText) {
    await appendMessage({ threadId, role: 'user', content: lastText });
    if ((await threadMessages(threadId)).length === 1) await titleThread(threadId, lastText);
  }

  const headroom = await checkHeadroom('google', 'chat');
  if (!headroom.allowed) {
    return Response.json(
      {
        error: 'quota_exhausted',
        message: `Today's chat allowance is spent (resets ${headroom.resetAt.toLocaleTimeString()}). There is no local fallback in this deployment.`,
      },
      { status: 429 },
    );
  }

  const { model, generatedBy } = getChatModel();
  const started = Date.now();
  await consume('google', 'chat');

  const systemPrompt = await buildSystemPrompt();

  const result = streamText({
    model,
    system: systemPrompt,
    messages: await convertToModelMessages(uiMessages),
    tools: coachTools(),
    // Tool loops need room, but not unbounded room — a runaway loop on a
    // rationed free tier is expensive in the only currency this app has.
    stopWhen: stepCountIs(8),
    temperature: 0.6,
    onFinish: ({ text, usage }) => {
      if (text.trim()) {
        void appendMessage({ threadId, role: 'assistant', content: text, generatedBy });
      }
      void recordRun({
        provider: 'google',
        model: generatedBy,
        operation: 'chat',
        status: 'ok',
        promptTokens: usage?.inputTokens ?? null,
        completionTokens: usage?.outputTokens ?? null,
        durationMs: Date.now() - started,
      });
    },
    onError: ({ error }) => {
      void recordRun({
        provider: 'google',
        operation: 'chat',
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      });
    },
  });

  return result.toUIMessageStreamResponse({ headers: { 'x-generated-by': generatedBy } });
}
