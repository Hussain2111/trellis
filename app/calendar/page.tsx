import Link from 'next/link';
import { dueNow, scheduledRows } from '@/lib/jobs/handlers/publish';
import { checklistFor, formatForClipboard } from '@/lib/publish/notify';
import { getSettings } from '@/lib/settings';
import { env } from '@/lib/env';
import { Badge, Empty, Panel, PanelHeader } from '@/components/ui/primitives';
import { ActionButton } from '@/components/action-button';
import { CopyButton } from '@/components/draft-editor';
import { markPostedAction, unscheduleAction } from '../actions';
import { formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const TONE = {
  pending: 'neutral',
  claimed: 'signal',
  publishing: 'signal',
  published: 'good',
  failed: 'bad',
} as const;

export default async function CalendarPage(): Promise<React.JSX.Element> {
  const rows = scheduledRows();
  const due = dueNow();
  const settings = getSettings();
  const publishingEnabled = env().ENABLE_IG_PUBLISHING;

  const upcoming = rows.filter((r) => r.schedule.status === 'pending' || r.schedule.status === 'claimed');
  const done = rows.filter((r) => r.schedule.status === 'published');
  const failed = rows.filter((r) => r.schedule.status === 'failed');

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold">Calendar</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            {settings.publishingMode === 'manual'
              ? 'Manual mode: you get a notification, then post from your phone. No Meta setup at all.'
              : publishingEnabled
                ? 'API mode: the worker publishes via the Graph API.'
                : 'API mode is selected but ENABLE_IG_PUBLISHING is false — nothing will publish.'}
          </p>
        </div>
        <Badge tone={settings.publishingMode === 'manual' ? 'neutral' : 'signal'}>
          {settings.publishingMode}
        </Badge>
      </header>

      {due.length > 0 && settings.publishingMode === 'manual' ? (
        <Panel className="mb-4 border-signal/30 bg-signal/[0.04]">
          <PanelHeader title="Ready to post" aside={<Badge tone="signal">{due.length}</Badge>} />
          <ul className="divide-y divide-line">
            {due.map(({ schedule: row, draft }) => (
              <li key={row.id} className="px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/drafts/${draft.id}`}
                      className="text-[15px] font-medium hover:underline"
                    >
                      {draft.title}
                    </Link>
                    <p className="mt-0.5 text-[13px] text-ink-muted">{draft.hook}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <CopyButton text={formatForClipboard(draft)} />
                    <ActionButton
                      action={markPostedAction.bind(null, row.id)}
                      label="mark posted"
                      variant="primary"
                    />
                  </div>
                </div>
                <ol className="mt-3 space-y-1">
                  {checklistFor(draft.format).map((item, index) => (
                    <li key={item.step} className="flex gap-2.5 text-[12px]">
                      <span className="metric text-ink-faint">{index + 1}</span>
                      <span>
                        {item.step}
                        <span className="ml-2 text-ink-faint">{item.detail}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel className="mb-4">
        <PanelHeader title="Upcoming" aside={<Badge>{upcoming.length}</Badge>} />
        {upcoming.length === 0 ? (
          <Empty
            title="Nothing scheduled."
            detail="Approve a draft and give it a time. The worker checks every minute."
          />
        ) : (
          <ul className="divide-y divide-line">
            {upcoming.map(({ schedule: row, draft }) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span className="metric w-40 shrink-0 text-[12px]">
                  {new Date(row.scheduledFor * 1000).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <Link href={`/drafts/${draft.id}`} className="min-w-0 flex-1 truncate text-[13px] hover:underline">
                  {draft.title}
                </Link>
                <Badge>{draft.format}</Badge>
                <Badge tone={TONE[row.status]}>{row.status}</Badge>
                {row.notifiedAt ? (
                  <span className="text-[11px] text-ink-faint">
                    notified {formatRelative(row.notifiedAt)}
                  </span>
                ) : null}
                <ActionButton
                  action={unscheduleAction.bind(null, row.id)}
                  label="unschedule"
                  variant="ghost"
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {failed.length > 0 ? (
        <Panel className="mb-4">
          <PanelHeader title="Failed" aside={<Badge tone="bad">{failed.length}</Badge>} />
          <ul className="divide-y divide-line">
            {failed.map(({ schedule: row, draft }) => (
              <li key={row.id} className="px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <Link href={`/drafts/${draft.id}`} className="text-[13px] hover:underline">
                    {draft.title}
                  </Link>
                  <span className="metric text-[11px] text-ink-faint">
                    {row.attempts} attempt{row.attempts === 1 ? '' : 's'}
                  </span>
                  <span className="ml-auto">
                    <ActionButton
                      action={unscheduleAction.bind(null, row.id)}
                      label="clear"
                      variant="ghost"
                    />
                  </span>
                </div>
                {row.lastError ? (
                  <p className="mt-1 text-[11px] text-negative">{row.lastError}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {done.length > 0 ? (
        <Panel>
          <PanelHeader title="Published" aside={<Badge tone="good">{done.length}</Badge>} />
          <ul className="divide-y divide-line">
            {done.slice(0, 20).map(({ schedule: row, draft }) => (
              <li key={row.id} className="flex items-center gap-3 px-4 py-2">
                <span className="text-[12px] text-ink-faint">
                  {formatRelative(row.publishedAt ?? row.scheduledFor)}
                </span>
                <Link href={`/drafts/${draft.id}`} className="truncate text-[13px] hover:underline">
                  {draft.title}
                </Link>
                {row.igMediaId ? (
                  <span className="ml-auto font-mono text-[11px] text-ink-faint">
                    {row.igMediaId}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
