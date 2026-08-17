import { scheduledRows } from '@/lib/publish/schedule';
import { env } from '@/lib/env';
import { Badge, Empty, Panel, PanelHeader } from '@/components/ui/primitives';
import {
  CalendarTickPoller,
  MarkPostedButton,
  UnscheduleButton,
} from '@/components/calendar-actions';

export const dynamic = 'force-dynamic';

const STATUS_TONE = {
  pending: 'neutral',
  claimed: 'signal',
  publishing: 'signal',
  published: 'good',
  failed: 'bad',
} as const;

export default async function CalendarPage(): Promise<React.JSX.Element> {
  const rows = await scheduledRows();
  const publishingEnabled = env().ENABLE_IG_PUBLISHING;

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <CalendarTickPoller />
      <header className="mb-5">
        <h1 className="text-[20px] leading-tight font-semibold">Calendar</h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          {publishingEnabled
            ? 'Live publishing is on — due posts go out via the Instagram Graph API automatically.'
            : 'Live publishing is off (ENABLE_IG_PUBLISHING=false) — post scheduled drafts by hand, then mark them posted.'}
        </p>
      </header>

      <Panel>
        <PanelHeader title="Scheduled" />
        {rows.length === 0 ? (
          <Empty title="Nothing scheduled." detail="Schedule a draft from the Drafts page." />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((row) => (
              <li key={row.schedule.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] text-ink">{row.draft.title}</span>
                    <Badge tone="neutral">{row.draft.format}</Badge>
                    <Badge tone={STATUS_TONE[row.schedule.status]}>{row.schedule.status}</Badge>
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-faint">
                    {new Date(row.schedule.scheduledFor).toLocaleString()}
                    {row.schedule.lastError ? ` · ${row.schedule.lastError}` : ''}
                  </div>
                </div>
                {row.schedule.status === 'pending' ? (
                  <div className="flex shrink-0 gap-2">
                    {!publishingEnabled ? <MarkPostedButton scheduleId={row.schedule.id} /> : null}
                    <UnscheduleButton scheduleId={row.schedule.id} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
