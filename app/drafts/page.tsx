import Link from 'next/link';
import { desc } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { drafts } from '@/lib/db/schema';
import { latestAnalysis } from '@/lib/jobs/handlers/analysis';
import { activeVoice } from '@/lib/analysis/voice';
import { Badge, Empty, Panel, PanelHeader } from '@/components/ui/primitives';
import { GeneratedBy } from '@/components/ui/data';
import { ActionButton } from '@/components/action-button';
import { generateDraftsAction } from '../actions';
import { formatRelative } from '@/lib/utils';
import type { Gap } from '@/lib/prompts/gap-analysis.v1';

export const dynamic = 'force-dynamic';

const STATUS_TONE = {
  draft: 'neutral',
  approved: 'good',
  scheduled: 'signal',
  published: 'good',
  discarded: 'bad',
} as const;

export default async function DraftsPage(): Promise<React.JSX.Element> {
  const rows = db().select().from(drafts).orderBy(desc(drafts.id)).all();
  const analysis = latestAnalysis();
  const voice = activeVoice();
  const gap = analysis ? (analysis.gap as Gap) : null;

  const byFormat = rows.reduce<Record<string, number>>((acc, d) => {
    acc[d.format] = (acc[d.format] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold">Drafts</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-ink-muted">
            {gap
              ? `Written against: ${gap.claim}`
              : 'No gap analysis yet — drafts are written to close a specific gap, not in general.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!voice ? <Badge tone="signal">no voice profile</Badge> : null}
          <ActionButton
            action={generateDraftsAction.bind(null, 12)}
            label="write 12 drafts"
            variant="primary"
          />
        </div>
      </header>

      {rows.length === 0 ? (
        <Panel>
          <Empty
            title="No drafts yet."
            detail={
              gap
                ? 'Generate a batch. The format mix mirrors what is winning in your niche rather than splitting evenly.'
                : 'Run a gap analysis first.'
            }
          />
        </Panel>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {Object.entries(byFormat).map(([format, count]) => (
              <Badge key={format}>
                {format} · {count}
              </Badge>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {rows.map((draft) => (
              <Panel key={draft.id} className="transition-colors hover:border-line-strong">
                <PanelHeader
                  title={draft.format}
                  aside={
                    <>
                      <Badge tone={STATUS_TONE[draft.status]}>{draft.status}</Badge>
                      <GeneratedBy value={draft.generatedBy} />
                    </>
                  }
                />
                <Link href={`/drafts/${draft.id}`} className="block px-4 py-3">
                  <h3 className="text-[14px] font-medium">{draft.title}</h3>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">{draft.hook}</p>
                  {draft.rationale ? (
                    <p className="mt-2 border-l border-line pl-2.5 text-[11px] text-ink-faint">
                      {draft.rationale}
                    </p>
                  ) : null}
                  <div className="mt-2.5 flex items-center gap-3 text-[11px] text-ink-faint">
                    <span>#{draft.id}</span>
                    {draft.patternIndex !== null ? (
                      <span>pattern {draft.patternIndex + 1}</span>
                    ) : null}
                    <span className="ml-auto">{formatRelative(draft.updatedAt)}</span>
                  </div>
                </Link>
              </Panel>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
