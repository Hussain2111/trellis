import Link from 'next/link';
import { createThread, listThreads, threadMessages } from '@/lib/chat/threads';
import { latestAnalysis } from '@/lib/jobs/handlers/analysis';
import { checkHeadroom } from '@/lib/quota/budget';
import { getSettings } from '@/lib/settings';
import { Badge, Panel } from '@/components/ui/primitives';
import { Chat } from '@/components/chat';
import { ActionButton } from '@/components/action-button';
import { createThreadAction, deleteThreadAction } from '../actions';
import { formatRelative } from '@/lib/utils';
import type { Gap } from '@/lib/prompts/gap-analysis.v1';

export const dynamic = 'force-dynamic';

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string }>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  let threads = listThreads();

  if (threads.length === 0) {
    createThread();
    threads = listThreads();
  }

  const threadId = params.thread ? Number(params.thread) : threads[0]!.id;
  const active = threads.find((t) => t.id === threadId) ?? threads[0]!;
  const messages = threadMessages(active.id);
  const headroom = checkHeadroom('google', 'chat');
  const settings = getSettings();
  const analysis = latestAnalysis();
  const gap = analysis ? (analysis.gap as Gap) : null;

  return (
    <div className="flex h-screen">
      <aside className="w-56 shrink-0 border-r border-line px-3 py-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="label">Threads</span>
          <ActionButton
            action={createThreadAction}
            label="new"
            variant="ghost"
          />
        </div>
        <ul className="space-y-0.5">
          {threads.map((thread) => (
            <li key={thread.id} className="group flex items-center gap-1">
              <Link
                href={`/chat?thread=${thread.id}`}
                className={`min-w-0 flex-1 truncate rounded-[3px] px-2 py-1.5 text-[12px] ${
                  thread.id === active.id
                    ? 'bg-surface-2 text-ink'
                    : 'text-ink-muted hover:bg-surface-2/60 hover:text-ink'
                }`}
                title={thread.title}
              >
                {thread.title}
                <span className="mt-0.5 block text-[10px] text-ink-faint">
                  {formatRelative(thread.updatedAt)}
                </span>
              </Link>
              {threads.length > 1 ? (
                <span className="opacity-0 transition-opacity group-hover:opacity-100">
                  <ActionButton
                    action={deleteThreadAction.bind(null, thread.id)}
                    label="×"
                    variant="ghost"
                    confirm="Delete this thread?"
                  />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col px-6 py-4">
        <header className="mb-3 flex flex-wrap items-center gap-2">
          <h1 className="text-[15px] font-semibold">Coach</h1>
          {settings.localOnlyVoiceAndChat ? (
            <Badge tone="signal">local only</Badge>
          ) : (
            <Badge tone={headroom.allowed ? 'good' : 'bad'}>
              {headroom.remaining}/{headroom.allowance} turns left today
            </Badge>
          )}
          {gap ? (
            <span className="ml-auto max-w-md truncate text-[12px] text-ink-faint" title={gap.claim}>
              knows: {gap.claim}
            </span>
          ) : (
            <span className="ml-auto text-[12px] text-ink-faint">no gap analysis yet</span>
          )}
        </header>

        <Panel className="min-h-0 flex-1 border-0 bg-transparent px-0">
          <Chat
            threadId={active.id}
            initialMessages={messages
              .filter((m) => m.role === 'user' || m.role === 'assistant')
              .map((m) => ({
                id: String(m.id),
                role: m.role as 'user' | 'assistant',
                text: m.content,
              }))}
          />
        </Panel>
      </div>
    </div>
  );
}
