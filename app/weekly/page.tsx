import { weeklyReport } from '@/lib/analytics/weekly';
import { Badge, Empty, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { Metric } from '@/components/ui/metric';
import { formatNumber } from '@/lib/utils';

export const dynamic = 'force-dynamic';

function Change({ value }: { value: number | null }): React.JSX.Element {
  if (value == null) {
    return (
      <span className="text-ink-faint" title="Nothing comparable in the previous week.">
        no comparison
      </span>
    );
  }
  if (value === 0) return <span className="text-ink-muted">no change</span>;
  return (
    <span className={value > 0 ? 'text-positive' : 'text-negative'}>
      {value > 0 ? '+' : ''}
      {formatNumber(value)} vs last week
    </span>
  );
}

export default async function WeeklyPage(): Promise<React.JSX.Element> {
  const report = await weeklyReport();

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <header className="mb-5">
        <h1 className="text-[20px] leading-tight font-semibold">This week</h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          {report.weekLabel} · Monday to Sunday, Riyadh time.
        </p>
      </header>

      <Panel className="mb-4">
        <PanelHeader
          title="Against last week"
          aside={
            report.planned > 0 ? (
              <Badge tone={report.missed > 0 ? 'bad' : 'good'}>
                {report.posted}/{report.planned} planned posts out
              </Badge>
            ) : null
          }
        />
        {report.notes.length > 0 ? (
          <div className="border-b border-line bg-signal/[0.06] px-4 py-2 text-[12px] text-signal/90">
            {report.notes.map((note, i) => (
              <p key={i}>{note}</p>
            ))}
          </div>
        ) : null}
        <div className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3">
          {report.metrics.map((m) => (
            <div key={m.label} className="bg-canvas">
              <Stat
                label={m.label}
                value={<Metric value={m.value} title="Not recorded for this week." />}
                sub={
                  <span className="block">
                    <Change value={m.change} />
                    {m.note ? <span className="mt-0.5 block text-ink-faint">{m.note}</span> : null}
                  </span>
                }
              />
            </div>
          ))}
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Best post this week" />
        {!report.topPost ? (
          <Empty
            title="Nothing published this week."
            detail="Posts appear here once the daily Graph API sync picks them up."
          />
        ) : (
          <div className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{report.topPost.type}</Badge>
              <span className="text-[12px] text-ink-muted">
                reach <Metric value={report.topPost.reach} /> · interactions{' '}
                <Metric value={report.topPost.interactions} />
              </span>
              <a
                className="ml-auto font-mono text-[11px] text-info hover:underline"
                href={
                  report.topPost.permalink ??
                  `https://www.instagram.com/p/${report.topPost.shortcode}/`
                }
                target="_blank"
                rel="noreferrer"
              >
                {report.topPost.shortcode} ↗
              </a>
            </div>
            {report.topPost.caption ? (
              <p className="mt-2 line-clamp-4 text-[12px] whitespace-pre-wrap text-ink-muted">
                {report.topPost.caption}
              </p>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}
