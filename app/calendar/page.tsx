import { calendarView, type CalendarRow } from '@/lib/publish/calendar-view';
import { env } from '@/lib/env';
import { formatRiyadh } from '@/lib/time';
import { Badge, Empty, Panel, PanelHeader } from '@/components/ui/primitives';
import { Metric } from '@/components/ui/metric';
import { CalendarTickPoller, EntryActions, NewEntryForm } from '@/components/calendar-actions';

export const dynamic = 'force-dynamic';

const STATE_TONE = {
  planned: 'neutral',
  due: 'signal',
  overdue: 'bad',
  publishing: 'signal',
  published: 'good',
  failed: 'bad',
} as const;

function Entry({
  row,
  publishingEnabled,
}: {
  row: CalendarRow;
  publishingEnabled: boolean;
}): React.JSX.Element {
  const { entry, state } = row;
  const editable = state !== 'published' && state !== 'publishing';

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="w-28 shrink-0 pt-0.5 text-[11px] text-ink-faint">
        {formatRiyadh(entry.scheduledFor, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-ink">{entry.title || 'Untitled'}</span>
          <Badge tone="neutral">{entry.format}</Badge>
          <Badge tone={STATE_TONE[state]}>{state}</Badge>
          {row.outcome ? (
            <span className="text-[11px] text-ink-faint">
              reach <Metric value={row.outcome.reach} /> · interactions{' '}
              <Metric value={row.outcome.totalInteractions} />
            </span>
          ) : null}
        </div>

        {entry.hook ? (
          <p className="mt-1.5 text-[12px] text-ink">
            <span className="label mr-2">hook</span>
            {entry.hook}
          </p>
        ) : null}
        {entry.caption ? (
          <p className="mt-1 text-[12px] whitespace-pre-wrap text-ink-muted">{entry.caption}</p>
        ) : null}
        {entry.hashtags.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {entry.hashtags.map((h) => (
              <span key={h} className="font-mono text-[11px] text-info">
                #{h}
              </span>
            ))}
          </div>
        ) : null}
        {entry.notes ? (
          <p className="mt-1 text-[11px] text-ink-faint">
            <span className="label mr-1">note</span>
            {entry.notes}
          </p>
        ) : null}
        {entry.lastError ? (
          <p className="mt-1 text-[11px] text-negative">{entry.lastError}</p>
        ) : null}
      </div>

      {editable ? (
        <EntryActions
          canPost={!publishingEnabled}
          entry={{
            id: entry.id,
            scheduledFor: entry.scheduledFor.toISOString(),
            format: entry.format,
            title: entry.title,
            hook: entry.hook ?? '',
            caption: entry.caption,
            hashtags: entry.hashtags,
            notes: entry.notes ?? '',
          }}
        />
      ) : null}
    </li>
  );
}

export default async function CalendarPage(): Promise<React.JSX.Element> {
  const view = await calendarView();
  const publishingEnabled = env().ENABLE_IG_PUBLISHING;
  const total = view.weeks.reduce((n, w) => n + w.rows.length, 0);

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <CalendarTickPoller />
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[20px] leading-tight font-semibold">Calendar</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            {publishingEnabled
              ? 'Live publishing is on — due entries with media URLs go out via the Graph API automatically.'
              : 'Copy, paste, post by hand, then mark it posted.'}{' '}
            Weeks run Monday to Sunday, Riyadh time.
          </p>
        </div>
        <NewEntryForm />
      </header>

      {view.needsAttention.length > 0 ? (
        <Panel className="mb-4 border-signal/30">
          <PanelHeader
            title="Needs posting"
            aside={
              <Badge tone={view.counts.overdue ? 'bad' : 'signal'}>
                {view.needsAttention.length} waiting
              </Badge>
            }
          />
          <ul className="divide-y divide-line">
            {view.needsAttention.map((row) => (
              <Entry key={row.entry.id} row={row} publishingEnabled={publishingEnabled} />
            ))}
          </ul>
        </Panel>
      ) : null}

      {total === 0 ? (
        <Panel>
          <PanelHeader title="Planned" />
          <Empty
            title="Nothing planned."
            detail="Use “plan a post” to add the first entry — v2 writes its own posts rather than generating them."
          />
        </Panel>
      ) : (
        <div className="space-y-4">
          {view.weeks.map((week) => (
            <Panel key={week.weekStart}>
              <PanelHeader
                title={week.label}
                aside={
                  <span className="text-[11px] text-ink-faint">
                    {week.rows.length} {week.rows.length === 1 ? 'entry' : 'entries'}
                  </span>
                }
              />
              <ul className="divide-y divide-line">
                {week.rows.map((row) => (
                  <Entry key={row.entry.id} row={row} publishingEnabled={publishingEnabled} />
                ))}
              </ul>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
