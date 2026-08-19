import { entryState, listEntries } from '@/lib/publish/schedule';
import { env } from '@/lib/env';
import { formatRiyadh } from '@/lib/time';
import { Badge, Empty, Panel, PanelHeader } from '@/components/ui/primitives';
import {
  CalendarTickPoller,
  DeleteEntryButton,
  MarkPostedButton,
  NewEntryForm,
} from '@/components/calendar-actions';

export const dynamic = 'force-dynamic';

const STATE_TONE = {
  planned: 'neutral',
  due: 'signal',
  overdue: 'bad',
  publishing: 'signal',
  published: 'good',
  failed: 'bad',
} as const;

export default async function CalendarPage(): Promise<React.JSX.Element> {
  const rows = await listEntries();
  const publishingEnabled = env().ENABLE_IG_PUBLISHING;
  const now = new Date();

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <CalendarTickPoller />
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[20px] leading-tight font-semibold">Calendar</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            {publishingEnabled
              ? 'Live publishing is on — due entries with media URLs go out via the Instagram Graph API automatically.'
              : 'Copy, paste, post by hand, then mark it posted. Times are Riyadh local.'}
          </p>
        </div>
        <NewEntryForm />
      </header>

      <Panel>
        <PanelHeader title="Planned" />
        {rows.length === 0 ? (
          <Empty
            title="Nothing planned."
            detail="Use “plan a post” to add the first entry — v2 writes its own posts rather than generating them."
          />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((row) => {
              const state = entryState(row, now);
              return (
                <li key={row.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] text-ink">{row.title || 'Untitled'}</span>
                      <Badge tone="neutral">{row.format}</Badge>
                      <Badge tone={STATE_TONE[state]}>{state}</Badge>
                    </div>
                    <div className="mt-0.5 text-[11px] text-ink-faint">
                      {formatRiyadh(row.scheduledFor)}
                      {row.lastError ? ` · ${row.lastError}` : ''}
                    </div>
                    {row.hook ? (
                      <p className="mt-1.5 text-[12px] text-ink">
                        <span className="label mr-2">hook</span>
                        {row.hook}
                      </p>
                    ) : null}
                    {row.caption ? (
                      <p className="mt-1 text-[12px] whitespace-pre-wrap text-ink-muted">
                        {row.caption}
                      </p>
                    ) : null}
                    {row.hashtags.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {row.hashtags.map((h) => (
                          <span key={h} className="font-mono text-[11px] text-info">
                            #{h}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {row.notes ? (
                      <p className="mt-1 text-[11px] text-ink-faint">
                        <span className="label mr-1">note</span>
                        {row.notes}
                      </p>
                    ) : null}
                  </div>
                  {state !== 'published' && state !== 'publishing' ? (
                    <div className="flex shrink-0 gap-2">
                      <MarkPostedButton entryId={row.id} />
                      <DeleteEntryButton entryId={row.id} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
