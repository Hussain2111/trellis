import { weeklyReport } from '@/lib/analytics/weekly';
import { currentWeekStart, listGeneratedWeeks, readGeneration } from '@/lib/generate/store';
import type { WeeklyResult } from '@/lib/prompts/weekly.v1';
import { Badge, Empty, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { Metric } from '@/components/ui/metric';
import { RegenerateButton } from '@/components/regenerate-button';
import { formatRiyadh } from '@/lib/time';
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

export default async function WeeklyPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const thisWeek = currentWeekStart();
  const week = params.week ?? thisWeek;

  const report = await weeklyReport();
  // Cache read only. Generation runs on the weekly cron.
  const generation = await readGeneration('weekly', week);
  const weeks = await listGeneratedWeeks('weekly');
  const written = generation?.status === 'ok' ? (generation.output as WeeklyResult | null) : null;
  const notes = (generation?.validationNotes as string[] | undefined) ?? [];

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[20px] leading-tight font-semibold">This week</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            {report.weekLabel} · Monday to Sunday, Riyadh time.
            {generation ? ` Read generated ${formatRiyadh(generation.createdAt)}.` : ''}
          </p>
        </div>
        {week === thisWeek ? <RegenerateButton kind="weekly" /> : null}
      </header>

      {weeks.length > 1 ? (
        <div className="mb-4 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="label mr-1">archive</span>
          {weeks.map((w) => (
            <a
              key={w.weekStart}
              href={`/weekly?week=${w.weekStart}`}
              className={`rounded-[3px] border px-2 py-0.5 font-mono ${
                w.weekStart === week
                  ? 'border-signal/40 bg-surface-2 text-ink'
                  : 'border-line text-ink-muted hover:text-ink'
              }`}
            >
              {w.weekStart}
            </a>
          ))}
        </div>
      ) : null}

      <Panel className="mb-4">
        <PanelHeader
          title={written ? written.headline : 'The read'}
          aside={
            written ? (
              <Badge tone="good">{generation!.generatedBy.split(':')[0]}</Badge>
            ) : (
              <Badge tone="neutral">unelaborated</Badge>
            )
          }
        />
        {!written ? (
          <div className="px-4 py-3 text-[12px] text-ink-muted">
            {!generation
              ? 'No written read has been generated for this week yet — the weekly cron produces it. The figures below are complete and unaffected.'
              : 'The model’s read did not survive validation this week, so only the computed figures below are shown.'}
            {notes.length > 0 ? (
              <ul className="mt-1 list-disc pl-4 text-ink-faint">
                {notes.slice(0, 4).map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3 px-4 py-3">
            <div>
              <div className="label mb-1">What happened</div>
              <p className="text-[13px] whitespace-pre-wrap text-ink">{written.recap}</p>
            </div>
            <div>
              <div className="label mb-1">Your niche</div>
              <p className="text-[13px] whitespace-pre-wrap text-ink">{written.trends}</p>
            </div>
            {written.nextWeek.length > 0 ? (
              <div>
                <div className="label mb-1.5">Next week</div>
                <ul className="space-y-2">
                  {written.nextWeek.map((n, i) => (
                    <li key={i} className="border-l-2 border-signal/40 pl-3">
                      <p className="text-[13px] text-ink">{n.action}</p>
                      <p className="mt-0.5 text-[12px] text-ink-muted">{n.why}</p>
                      {n.postIds.length > 0 ? (
                        <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
                          {n.postIds.map((id) => `#${id}`).join(' ')}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </Panel>

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
        <PanelHeader
          title="Best post this week"
          aside={<span className="text-[11px] text-ink-faint">computed, not generated</span>}
        />
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
