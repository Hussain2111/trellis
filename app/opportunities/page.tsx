import { opportunities } from '@/lib/analytics/opportunities';
import { currentWeekStart, listGeneratedWeeks, readGeneration } from '@/lib/generate/store';
import type { OpportunitiesResult } from '@/lib/prompts/opportunities.v1';
import { Badge, Empty, Panel, PanelHeader } from '@/components/ui/primitives';
import { RegenerateButton } from '@/components/regenerate-button';
import { formatRiyadh } from '@/lib/time';

export const dynamic = 'force-dynamic';

const KIND_TONE = { pattern: 'signal', format: 'good', hook: 'info' } as const;
const KIND_LABEL = { pattern: 'niche pattern', format: 'your formats', hook: 'hooks' } as const;
const DIRECTION_TONE = { do_more: 'good', do_less: 'bad', keep: 'neutral' } as const;
const DIRECTION_LABEL = { do_more: 'do more', do_less: 'do less', keep: 'hold' } as const;

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const thisWeek = currentWeekStart();
  const week = params.week ?? thisWeek;

  // Page loads read the cache and never generate. Generation happens on the
  // weekly cron; a model call per request would spend the free-tier rate
  // limit on page views.
  const generation = await readGeneration('opportunities', week);
  const weeks = await listGeneratedWeeks('opportunities');
  const deterministic = await opportunities();

  const generated =
    generation?.status === 'ok'
      ? ((generation.output as OpportunitiesResult | null)?.insights ?? [])
      : [];
  const notes = (generation?.validationNotes as string[] | undefined) ?? [];

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[20px] leading-tight font-semibold">Opportunities</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            SQL computes the numbers; Gemini reads them. Week of {week}.
            {generation ? ` Generated ${formatRiyadh(generation.createdAt)}.` : ''}
          </p>
        </div>
        {week === thisWeek ? <RegenerateButton kind="opportunities" /> : null}
      </header>

      {weeks.length > 1 ? (
        <div className="mb-4 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="label mr-1">archive</span>
          {weeks.map((w) => (
            <a
              key={w.weekStart}
              href={`/opportunities?week=${w.weekStart}`}
              className={`rounded-[3px] border px-2 py-0.5 font-mono ${
                w.weekStart === week
                  ? 'border-signal/40 bg-surface-2 text-ink'
                  : 'border-line text-ink-muted hover:text-ink'
              }`}
            >
              {w.weekStart}
              {w.status === 'fallback' ? ' ·' : ''}
            </a>
          ))}
        </div>
      ) : null}

      <Panel className="mb-4">
        <PanelHeader
          title="The read"
          aside={
            generated.length > 0 ? (
              <Badge tone="good">{generation!.generatedBy.split(':')[0]}</Badge>
            ) : (
              <Badge tone="neutral">unelaborated</Badge>
            )
          }
        />

        {generated.length === 0 ? (
          <div className="border-b border-line bg-signal/[0.06] px-4 py-2 text-[12px] text-signal/90">
            {!generation
              ? 'No generation has run for this week yet — the weekly cron produces it. The deterministic findings below are unelaborated, not missing.'
              : 'Nothing from the model survived validation this week, so only the deterministic findings below are shown.'}
            {notes.length > 0 ? (
              <ul className="mt-1 list-disc pl-4">
                {notes.slice(0, 4).map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {generated.map((insight, i) => (
              <li key={i} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="metric text-[11px] text-ink-faint">{i + 1}</span>
                  <Badge tone={DIRECTION_TONE[insight.direction]}>
                    {DIRECTION_LABEL[insight.direction]}
                  </Badge>
                </div>
                <p className="mt-1.5 text-[13px] text-ink">{insight.finding}</p>
                <p className="mt-1 text-[12px] text-ink-muted">
                  <span className="label mr-1.5">next</span>
                  {insight.action}
                </p>
                <p className="mt-1.5 font-mono text-[11px] text-ink-faint">
                  <span className="label mr-1.5">receipts</span>
                  {insight.postIds.map((id) => `#${id}`).join(' ')}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <PanelHeader
          title="The figures underneath"
          aside={<span className="text-[11px] text-ink-faint">computed, not generated</span>}
        />
        {deterministic.notes.length > 0 ? (
          <div className="border-b border-line bg-signal/[0.06] px-4 py-2 text-[12px] text-signal/90">
            {deterministic.notes.map((note, i) => (
              <p key={i}>{note}</p>
            ))}
          </div>
        ) : null}
        {deterministic.opportunities.length === 0 ? (
          <Empty
            title="Nothing to compute yet."
            detail="Derived from the niche pattern analysis, your own reach by format, and hook classification — each needs enough posts behind it to be worth acting on."
          />
        ) : (
          <ul className="divide-y divide-line">
            {deterministic.opportunities.map((item, i) => (
              <li key={`${item.kind}-${i}`} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] text-ink">{item.title}</span>
                  <Badge tone={KIND_TONE[item.kind]}>{KIND_LABEL[item.kind]}</Badge>
                  <span className="ml-auto text-[11px] text-ink-faint">n={item.sampleSize}</span>
                </div>
                <p className="mt-1.5 text-[12px] text-ink-muted">{item.detail}</p>
                {item.receipts.length > 0 ? (
                  <p className="mt-1.5 font-mono text-[11px] text-ink-faint">
                    <span className="label mr-1.5">receipts</span>
                    {item.receipts.map((id) => `#${id}`).join(' ')}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="mt-3 text-[11px] text-ink-faint">
        Every figure on this page was computed in SQL. The model above only interprets and
        prioritises them — any insight it produced containing a number absent from the computed
        payload was dropped before this page rendered, not caveated.
      </p>
    </div>
  );
}
