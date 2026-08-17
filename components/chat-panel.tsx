'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { Badge, Button, Empty, Input, Panel, PanelHeader } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

export type InitialUIMessage = UIMessage;

type ThreadSummary = { id: number; title: string; updatedAt: string };

/**
 * The coach: a thread list plus a streaming conversation. Grounded entirely
 * in read-only tools over data this build already computed — there is
 * nothing here for the model to invent.
 */
export function ChatPanel({
  threads,
  activeThreadId,
  initialMessages,
}: {
  threads: ThreadSummary[];
  activeThreadId: number | null;
  initialMessages: InitialUIMessage[];
}): React.JSX.Element {
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  async function newThread(): Promise<void> {
    setCreating(true);
    try {
      const res = await fetch('/api/chat/threads', { method: 'POST' });
      const body = (await res.json()) as { id: number };
      router.push(`/chat?thread=${body.id}`);
      router.refresh();
    } finally {
      setCreating(false);
    }
  }

  async function removeThread(id: number): Promise<void> {
    await fetch(`/api/chat/threads/${id}`, { method: 'DELETE' });
    if (id === activeThreadId) router.push('/chat');
    router.refresh();
  }

  return (
    <div className="mx-auto flex h-screen max-w-5xl gap-4 px-6 py-6">
      <div className="flex w-56 shrink-0 flex-col">
        <Panel className="flex flex-1 flex-col overflow-hidden">
          <PanelHeader
            title="Threads"
            aside={
              <Button
                size="sm"
                variant="primary"
                onClick={() => void newThread()}
                disabled={creating}
              >
                + new
              </Button>
            }
          />
          {threads.length === 0 ? (
            <Empty title="No threads yet." detail="Start a conversation with the coach." />
          ) : (
            <ul className="flex-1 divide-y divide-line overflow-y-auto">
              {threads.map((t) => (
                <li key={t.id} className="group flex items-center">
                  <a
                    href={`/chat?thread=${t.id}`}
                    className={cn(
                      'flex-1 truncate px-3 py-2 text-[12px]',
                      t.id === activeThreadId
                        ? 'bg-surface-2 text-ink'
                        : 'text-ink-muted hover:text-ink',
                    )}
                  >
                    {t.title}
                  </a>
                  <button
                    type="button"
                    onClick={() => void removeThread(t.id)}
                    className="px-2 text-[11px] text-ink-faint opacity-0 hover:text-negative group-hover:opacity-100"
                    aria-label={`Delete thread ${t.title}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="flex flex-1 flex-col">
        {activeThreadId ? (
          <ChatThread
            key={activeThreadId}
            threadId={activeThreadId}
            initialMessages={initialMessages}
          />
        ) : (
          <Panel className="flex flex-1 items-center justify-center">
            <Empty
              title="No thread selected."
              detail="Create a thread to ask the coach about your gap, your winners, or what to post next."
              action={
                <Button variant="primary" onClick={() => void newThread()} disabled={creating}>
                  + new thread
                </Button>
              }
            />
          </Panel>
        )}
      </div>
    </div>
  );
}

function ChatThread({
  threadId,
  initialMessages,
}: {
  threadId: number;
  initialMessages: InitialUIMessage[];
}): React.JSX.Element {
  const router = useRouter();
  const [input, setInput] = useState('');
  const { messages, sendMessage, status, error } = useChat({
    id: String(threadId),
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: '/api/chat', body: { threadId } }),
    onFinish: () => router.refresh(),
  });

  const busy = status === 'submitted' || status === 'streaming';

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    void sendMessage({ text });
  }

  return (
    <Panel className="flex flex-1 flex-col overflow-hidden">
      <PanelHeader title="Coach" aside={<Badge tone="signal">grounded in your analysis</Badge>} />
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <Empty
            title="Ask about your gap, your winners, or what to post next."
            detail="The coach only knows what this build has already computed — no guesses beyond your data."
          />
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[80%] rounded-[4px] border px-3 py-2 text-[13px] whitespace-pre-wrap',
                  m.role === 'user'
                    ? 'border-signal/30 bg-signal/10 text-ink'
                    : 'border-line-strong bg-surface-2 text-ink',
                )}
              >
                {m.parts
                  .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                  .map((p) => p.text)
                  .join('')}
              </div>
            </div>
          ))
        )}
        {busy ? <div className="text-[12px] text-ink-faint">thinking…</div> : null}
        {error ? <div className="text-[12px] text-negative">{error.message}</div> : null}
      </div>
      <form onSubmit={onSubmit} className="flex items-center gap-2 border-t border-line px-4 py-3">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the coach…"
          aria-label="Message"
          disabled={busy}
        />
        <Button type="submit" variant="primary" disabled={busy || !input.trim()}>
          send
        </Button>
      </form>
    </Panel>
  );
}
