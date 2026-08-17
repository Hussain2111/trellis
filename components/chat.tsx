'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useState } from 'react';
import { Badge, Button, Input } from '@/components/ui/primitives';

/**
 * The coach. Streaming, tool-calling, and honest about which model answered.
 *
 * The quota case is handled visibly rather than by silently starting a
 * four-minute local generation: chat carries a long system prompt, and on this
 * hardware that is minutes of prefill before a single token appears.
 */
export function Chat({
  threadId,
  initialMessages,
}: {
  threadId: number;
  initialMessages: { id: string; role: 'user' | 'assistant'; text: string }[];
}): React.JSX.Element {
  const [input, setInput] = useState('');
  const [quotaError, setQuotaError] = useState<string | null>(null);

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
      body: { threadId },
    }),
    messages: initialMessages.map((m) => ({
      id: m.id,
      role: m.role,
      parts: [{ type: 'text' as const, text: m.text }],
    })),
    onError: async (err) => {
      try {
        const parsed = JSON.parse(err.message) as { error?: string; message?: string };
        if (parsed.error === 'quota_exhausted') setQuotaError(parsed.message ?? 'Quota exhausted.');
      } catch {
        setQuotaError(null);
      }
    },
  });

  const busy = status === 'submitted' || status === 'streaming';

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {messages.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-[14px] text-ink-muted">Ask me something about your account.</p>
            <p className="mx-auto mt-2 max-w-md text-[12px] text-ink-faint">
              I do not have your posts in front of me — I look things up when you ask, which is what
              keeps each turn inside the free tier&apos;s per-minute limit.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {[
                'What is my biggest gap right now?',
                'Which of my old posts should I remake?',
                'Why are my carousels underperforming?',
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void sendMessage({ text: suggestion })}
                  className="rounded-[3px] border border-line-strong bg-surface-2 px-2.5 py-1 text-[12px] text-ink-muted hover:border-ink-faint hover:text-ink"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((message) => (
          <div key={message.id} className="flex gap-3">
            <span
              className={`label mt-1 w-14 shrink-0 ${message.role === 'user' ? 'text-ink-faint' : 'text-signal/70'}`}
            >
              {message.role === 'user' ? 'you' : 'coach'}
            </span>
            <div className="min-w-0 flex-1 space-y-2">
              {message.parts.map((part, index) => {
                if (part.type === 'text') {
                  return (
                    <p
                      key={index}
                      className="text-[14px] leading-relaxed whitespace-pre-wrap text-ink"
                    >
                      {part.text}
                    </p>
                  );
                }
                const type: string = part.type;
                if (type.startsWith('tool-')) {
                  return (
                    <div key={index} className="flex items-center gap-2">
                      <Badge tone="info">{type.replace('tool-', '')}</Badge>
                      <span className="text-[11px] text-ink-faint">looked it up</span>
                    </div>
                  );
                }
                return null;
              })}
            </div>
          </div>
        ))}

        {busy ? (
          <div className="flex gap-3">
            <span className="label mt-1 w-14 shrink-0 text-signal/70">coach</span>
            <span className="text-[13px] text-ink-faint">thinking…</span>
          </div>
        ) : null}

        {quotaError ? (
          <div className="rounded-[3px] border border-signal/30 bg-signal/[0.06] px-3 py-2.5">
            <div className="label text-signal/70">out of headroom</div>
            <p className="mt-1 text-[13px] text-ink-muted">{quotaError}</p>
            <p className="mt-1.5 text-[12px] text-ink-faint">
              Falling back to the local model for chat means minutes of prefill before the first
              token — the system prompt alone is long. Waiting until tomorrow is usually the better
              trade.
            </p>
          </div>
        ) : error && !quotaError ? (
          <p className="text-[12px] text-negative">{error.message}</p>
        ) : null}
      </div>

      <form
        className="mt-3 flex gap-2 border-t border-line pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || busy) return;
          setQuotaError(null);
          void sendMessage({ text: input });
          setInput('');
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the coach…"
          disabled={busy}
        />
        <Button type="submit" variant="primary" disabled={busy || !input.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
}
