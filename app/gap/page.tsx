import { latestAnalysis } from '@/lib/analysis/gap';
import type { Gap, Pattern } from '@/lib/analysis/patterns';
import { Badge, Empty, Panel, PanelHeader } from '@/components/ui/primitives';
import { Delta, GeneratedBy, Share, Table } from '@/components/ui/data';
import { formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

function Receipts({ ids }: { ids: number[] }): React.JSX.Element {
  const shown = ids.slice(0, 8);
  return (
    <span className="font-mono text-[11px] text-ink-faint">
      {shown.length === 0 ? 'no posts' : shown.map((id) => `#${id}`).join(' ')}
      {ids.length > shown.length ? ` +${ids.length - shown.length} more` : ''}
    </span>
  );
}

export default async function GapPage(): Promise<React.JSX.Element> {
  const analysis = await latestAnalysis();

  if (!analysis) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-6">
        <Panel>
          <PanelHeader title="Gap analysis" />
          <Empty
            title="No analysis has been run yet."
            detail="Runs automatically once your posts are scanned, featurized, and hook-classified."
          />
        </Panel>
      </div>
    );
  }

  const patterns = analysis.patterns as (Pattern & { claim?: string })[];
  const gap = analysis.gap as Gap;

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[20px] leading-tight font-semibold">Gap analysis</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            {analysis.windowDays}-day window · {formatRelative(analysis.createdAt)}
          </p>
        </div>
        <GeneratedBy value={analysis.generatedBy} />
      </header>

      <Panel className="mb-4 border-signal/30">
        <PanelHeader title="The biggest gap" aside={<Badge tone="signal">{gap.name}</Badge>} />
        <div className="px-4 py-3">
          <p className="text-[14px] text-ink">{gap.claim}</p>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <div>
              <span className="label mr-2">Niche</span>
              <Share
                share={gap.nicheStat}
                n={gap.nichePostIds.length}
                total={gap.nicheSampleSize}
              />
            </div>
            <div>
              <span className="label mr-2">You</span>
              <Share share={gap.myStat} n={gap.myPostIds.length} total={gap.mySampleSize} />
            </div>
            <Delta value={gap.deltaPct / 100} />
          </div>
          <div className="mt-3 space-y-1">
            <div>
              <span className="label mr-2">Niche receipts</span>
              <Receipts ids={gap.nichePostIds} />
            </div>
            <div>
              <span className="label mr-2">Your receipts</span>
              <Receipts ids={gap.myPostIds} />
            </div>
          </div>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="All 5 patterns, ranked by delta" />
        <Table head={['Pattern', 'Niche', 'You', 'Delta', 'Receipts']}>
          {patterns.map((p) => (
            <tr key={p.key}>
              <td className="px-4 py-2">{p.name}</td>
              <td className="px-4 py-2">
                <Share share={p.nicheStat} n={p.nichePostIds.length} total={p.nicheSampleSize} />
              </td>
              <td className="px-4 py-2">
                <Share share={p.myStat} n={p.myPostIds.length} total={p.mySampleSize} />
              </td>
              <td className="px-4 py-2">
                <Delta value={p.deltaPct / 100} />
              </td>
              <td className="px-4 py-2">
                <Receipts ids={p.nichePostIds} />
              </td>
            </tr>
          ))}
        </Table>
      </Panel>
    </div>
  );
}
