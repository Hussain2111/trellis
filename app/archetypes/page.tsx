import {
  activeArchetypes,
  archetypeCrossTab,
  postsForArchetype,
  shouldRecluster,
} from '@/lib/analysis/archetypes';
import { Badge, Button, Empty, Input, Panel, PanelHeader } from '@/components/ui/primitives';
import { Delta, Table } from '@/components/ui/data';
import { ActionButton } from '@/components/action-button';
import { renameArchetypeAction, runJobAction } from '../actions';
import { formatNumber, formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function ArchetypesPage(): Promise<React.JSX.Element> {
  const archetypes = activeArchetypes();
  const crossTab = archetypeCrossTab();
  const drift = shouldRecluster();
  const crossByArchetype = new Map(crossTab.map((c) => [c.archetypeId, c]));

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold">Archetypes</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-ink-muted">
            Clustered from your actual corpus, then named in a single call. Rename any of them —
            your names survive re-clustering by centroid matching.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ActionButton action={runJobAction.bind(null, 'embed_posts')} label="embed posts" />
          <ActionButton
            action={runJobAction.bind(null, 'cluster_posts')}
            label="re-cluster"
            confirm="Re-cluster the corpus? Names you set are kept where the cluster still matches."
          />
        </div>
      </header>

      {archetypes.length === 0 ? (
        <Panel>
          <Empty
            title="No archetypes yet."
            detail="Embed the corpus first (local, free, a few minutes), then cluster it. Naming is one Tier A call for the whole set."
          />
        </Panel>
      ) : (
        <>
          {drift.recommended ? (
            <Panel className="mb-4 border-signal/30 bg-signal/[0.05]">
              <div className="px-4 py-3 text-[13px] text-signal/90">
                {(drift.drift * 100).toFixed(0)}% of posts now sit far from every centroid. The
                archetype set has stopped describing the corpus — worth re-clustering.
              </div>
            </Panel>
          ) : null}

          <Panel className="mb-4">
            <PanelHeader
              title={`Cross-tab (${archetypes.length} archetypes)`}
              aside={<span className="text-[11px] text-ink-faint">share of each side&apos;s posts</span>}
            />
            <Table head={['archetype', 'me', 'niche', 'delta', 'median ER', 'last used by me']}>
              {crossTab.map((row) => (
                <tr key={row.archetypeId} className={row.delta > 0.05 ? 'bg-signal/[0.04]' : ''}>
                  <td className="px-4 py-1.5">{row.name}</td>
                  <td className="px-4 py-1.5 metric">
                    {(row.mineShare * 100).toFixed(0)}%
                    <span className="ml-1 text-[11px] text-ink-faint">({row.mine})</span>
                  </td>
                  <td className="px-4 py-1.5 metric">
                    {(row.nicheShare * 100).toFixed(0)}%
                    <span className="ml-1 text-[11px] text-ink-faint">({row.niche})</span>
                  </td>
                  <td className="px-4 py-1.5">
                    <Delta value={row.delta} />
                  </td>
                  <td className="px-4 py-1.5 tabular">
                    {(row.medianEngagementRate * 100).toFixed(2)}%
                  </td>
                  <td className="px-4 py-1.5 text-ink-faint">
                    {row.lastUsedByMe ? formatRelative(row.lastUsedByMe) : 'never'}
                  </td>
                </tr>
              ))}
            </Table>
          </Panel>

          <div className="grid gap-4">
            {archetypes.map((archetype) => {
              const examples = postsForArchetype(archetype.id, 4);
              const cross = crossByArchetype.get(archetype.id);
              return (
                <Panel key={archetype.id}>
                  <PanelHeader
                    title={archetype.name}
                    aside={
                      <>
                        {archetype.userRenamed ? <Badge tone="signal">your name</Badge> : null}
                        <Badge>{archetype.size} posts</Badge>
                        {cross ? <Delta value={cross.delta} /> : null}
                      </>
                    }
                  />
                  <div className="px-4 py-3">
                    <p className="text-[13px] text-ink-muted">
                      {archetype.description || 'No description.'}
                    </p>

                    <ul className="mt-3 space-y-1">
                      {examples.map((e) => (
                        <li key={e.post.id} className="flex items-baseline gap-3 text-[12px]">
                          <span className="metric w-16 shrink-0 text-ink-faint">
                            {formatNumber(e.post.likes)}
                          </span>
                          <span className="truncate text-ink-muted">
                            {(e.post.caption ?? '').split('\n')[0]?.slice(0, 110) || '—'}
                          </span>
                        </li>
                      ))}
                    </ul>

                    <form action={renameArchetypeAction} className="mt-3 flex flex-wrap gap-2">
                      <input type="hidden" name="id" value={archetype.id} />
                      <Input
                        name="name"
                        defaultValue={archetype.name}
                        className="max-w-[14rem] flex-1"
                      />
                      <Input
                        name="description"
                        defaultValue={archetype.description ?? ''}
                        placeholder="what these have in common"
                        className="min-w-[16rem] flex-[2]"
                      />
                      <Button size="sm" type="submit">
                        Rename
                      </Button>
                    </form>
                  </div>
                </Panel>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
