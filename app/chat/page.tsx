import { listThreads, threadMessages } from '@/lib/chat/threads';
import { ChatPanel, type InitialUIMessage } from '@/components/chat-panel';

export const dynamic = 'force-dynamic';

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string }>;
}): Promise<React.JSX.Element> {
  const { thread } = await searchParams;
  const threads = await listThreads();
  const activeThreadId = thread ? Number(thread) : (threads[0]?.id ?? null);

  const stored = activeThreadId ? await threadMessages(activeThreadId) : [];
  const initialMessages: InitialUIMessage[] = stored
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      id: String(m.id),
      role: m.role as 'user' | 'assistant',
      parts: [{ type: 'text', text: m.content }],
    }));

  return (
    <ChatPanel
      threads={threads.map((t) => ({
        id: t.id,
        title: t.title,
        updatedAt: t.updatedAt.toISOString(),
      }))}
      activeThreadId={activeThreadId}
      initialMessages={initialMessages}
    />
  );
}
