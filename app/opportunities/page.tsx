import { opportunities } from '@/lib/analytics/opportunities';
import { Badge, Empty, Panel, PanelHeader } from '@/components/ui/primitives';
import { formatRiyadh } from '@/lib/time';

export const dynamic = 'force-dynamic';

const KIND_TONE = { pattern: 'signal', format: 'good', hook: 'info' } as const;
const KIND_LABEL = { pattern: 'niche pattern', format: 'your formats', hook: 'hooks' } as const;

export default async function OpportunitiesPage(): Promise<React.JSX.Element> {
  const { opportunities: list, analysedAt, notes } = await opportunities();

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <header className="mb-5">
        <h1 className="text-[20px] leading-tight font-semibold">Opportunities</h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          Ranked by how big the gap is.
          {analysedAt ? ` Pattern analysis last ran ${formatRiyadh(analysedAt)}.` : ''}
        </p>
      </header>

      <Panel>
        <PanelHeader
          title="What to change"
          aside={
            list.length > 0 ? (
              <span className="text-[11px] text-ink-faint">{list.length} found</span>
            ) : null
          }
        />

        {notes.length > 0 ? (
          <div className="border-b border-line bg-signal/[0.06] px-4 py-2 text-[12px] text-signal/90">
            {notes.map((note, i) => (
              <p key={i}>{note}</p>
            ))}
          </div>
        ) : null}

        {list.length === 0 ? (
          <Empty
            title="Nothing to suggest yet."
            detail="Opportunities are derived from the niche pattern analysis, your own reach by format, and hook classification — each needs enough data behind it to be worth acting on."
          />
        ) : (
          <ul className="divide-y divide-line">
            {list.map((item, i) => (
              <li key={`${item.kind}-${item.title}-${i}`} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="metric text-[11px] text-ink-faint">{i + 1}</span>
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
        Every line above carries the numbers it came from and the post ids behind it. Anything that
        could not be computed from enough posts is left off rather than softened into a vague
        suggestion.
      </p>
    </div>
  );
}
