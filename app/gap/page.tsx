import Link from 'next/link';
import { loadCorpus, poolComposition, postsByIds } from '@/lib/analysis/benchmark';
import { detectDecay } from '@/lib/analysis/aggregate';
import { latestAnalysis } from '@/lib/jobs/handlers/analysis';
import { getSettings } from '@/lib/settings';
import { Badge, Empty, Panel, PanelHeader } from '@/components/ui/primitives';
import { GeneratedBy, PoolWarning } from '@/components/ui/data';
import { ActionButton } from '@/components/action-button';
import { generateDraftsAction, runJobAction } from '../actions';
import { formatNumber, formatRelative } from '@/lib/utils';
import type { Gap, Pattern } from '@/lib/prompts/gap-analysis.v1';

export const dynamic = 'force-dynamic';

/** Every claim's receipts, one click away. */
function Evidence({ ids }: { ids: number[] }): React.JSX.Element | null {
  if (ids.length === 0) {
    return <span className="text-[11px] text-negative">no evidence attached</span>;
  }
  const found = postsByIds(ids);
  return (
    <details className="mt-2">
      <summary className="label cursor-pointer hover:text-ink-muted">
        {found.length} post{found.length === 1 ? '' : 's'} behind this
      </summary>
      <ul className="mt-2 space-y-1 border-l border-line pl-3">
        {found.map((post) => (
          <li key={post.id} className="flex items-baseline gap-3 text-[12px]">
            <span className="metric w-14 shrink-0 text-ink-faint">{formatNumber(post.likes)}</span>
            <span className="font-mono text-[11px] text-ink-faint">{post.type}</span>
            <span className="truncate text-ink-muted">
              {(post.caption ?? '').split('\n')[0]?.slice(0, 100) || post.shortcode}
            </span>
          </li>
        ))}
        {found.length < ids.length ? (
          <li className="text-[11px] text-negative">
            {ids.length - found.length} cited post(s) no longer exist.
          </li>
        ) : null}
      </ul>
    </details>
  );
}

function StatRow({ item }: { item: Pattern }): React.JSX.Element {
  return (
    <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1">
      <span className="metric text-[13px] text-ink">
        <span className="label mr-1.5">niche</span>
        {item.niche_stat}
      </span>
      <span className="metric text-[13px] text-ink">
        <span className="label mr-1.5">you</span>
        {item.my_stat}
      </span>
      <span className="metric text-[13px] text-signal">
        <span className="label mr-1.5">delta</span>
        {item.delta}
      </span>
    </div>
  );
}

export default async function GapPage(): Promise<React.JSX.Element> {
  const analysis = latestAnalysis();
  const settings = getSettings();
  const corpus = loadCorpus();
  const pool = poolComposition(corpus);
  const decayed = detectDecay(settings.analysisWindowDays, settings.outlierMultiplier);

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold">The gap</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            {analysis
              ? `Last run ${formatRelative(analysis.createdAt)} over a ${analysis.windowDays}-day window.`
              : 'Not run yet.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {analysis ? <GeneratedBy value={analysis.generatedBy} /> : null}
          <ActionButton action={runJobAction.bind(null, 'run_analysis')} label="run analysis" />
          {analysis ? (
            <ActionButton
              action={generateDraftsAction.bind(null, 12)}
              label="write 12 drafts"
              variant="primary"
            />
          ) : null}
        </div>
      </header>

      {!analysis ? (
        <Panel>
          <Empty
            title="No analysis yet."
            detail="It needs your posts, a competitor pool, and archetypes. Everything before this point is free and local — this step is the one rationed call."
          />
        </Panel>
      ) : (
        <>
          {(() => {
            const gap = analysis.gap as Gap & { repaired?: boolean };
            return (
              <Panel className="mb-4 border-signal/25 bg-signal/[0.04]">
                <div className="px-5 py-5">
                  <div className="label text-signal/70">Biggest gap</div>
                  <p className="mt-2 text-[17px] leading-relaxed">{gap.claim}</p>
                  <StatRow item={gap} />
                  <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">
                    {gap.why_this_one}
                  </p>
                  <Evidence ids={gap.evidence} />
                  {gap.repaired ? (
                    <p className="mt-3 text-[11px] text-signal">
                      Some claims did not reconcile against the underlying numbers twice in a row.
                      Unverifiable evidence was dropped rather than shown to you as fact.
                    </p>
                  ) : null}
                </div>
              </Panel>
            );
          })()}

          <Panel className="mb-4">
            <PanelHeader
              title="Five winning patterns"
              aside={
                <span className="text-[11px] text-ink-faint">
                  {pool.accounts.length} accounts · {pool.totalPosts} posts
                </span>
              }
            />
            <PoolWarning warning={pool.warning} />
            <ul className="divide-y divide-line">
              {(analysis.patterns as Pattern[]).map((pattern, index) => (
                <li key={index} className="px-5 py-4">
                  <div className="flex items-baseline gap-3">
                    <span className="metric text-[12px] text-ink-faint">{index + 1}</span>
                    <p className="flex-1 text-[14px] leading-relaxed">{pattern.claim}</p>
                  </div>
                  <div className="pl-7">
                    <StatRow item={pattern} />
                    <Evidence ids={pattern.evidence} />
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}

      {decayed.length > 0 ? (
        <Panel>
          <PanelHeader
            title="Back catalogue"
            aside={<Badge tone="signal">pure arithmetic</Badge>}
          />
          <ul className="divide-y divide-line">
            {decayed.slice(0, 6).map((row) => (
              <li key={row.archetypeId} className="px-5 py-3">
                <p className="text-[13px]">
                  Your <span className="text-ink">{row.name}</span> posts hit a median of{' '}
                  <span className="metric text-signal">{formatNumber(row.medianLikesWhenUsed)}</span>{' '}
                  likes across {row.winnerCount} winner{row.winnerCount === 1 ? '' : 's'}. In the
                  last {settings.analysisWindowDays} days you made{' '}
                  <span className="metric text-negative">zero</span> like it
                  {row.lastUsedDaysAgo !== null ? ` — last one was ${row.lastUsedDaysAgo} days ago` : ''}.
                </p>
              </li>
            ))}
          </ul>
          <div className="border-t border-line px-5 py-2 text-[11px] text-ink-faint">
            No model was involved in this section.{' '}
            <Link href="/archetypes" className="text-info hover:underline">
              See the archetypes
            </Link>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
