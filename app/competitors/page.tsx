import { poolComposition } from '@/lib/analysis/corpus';
import { competitorStats } from '@/lib/analytics/competitors';
import { getApifySpend } from '@/lib/ingest/budget';
import { selfAccount } from '@/lib/ingest/upsert';
import { env } from '@/lib/env';
import { Badge, Empty, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { PoolWarning, Table } from '@/components/ui/data';
import { Metric } from '@/components/ui/metric';
import { AddCompetitorForm, CompetitorRowActions } from '@/components/competitor-actions';
import { formatRiyadh } from '@/lib/time';
import { formatNumber, formatRelative, formatUsd } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function CompetitorsPage(): Promise<React.JSX.Element> {
  const self = await selfAccount();
  const stats = await competitorStats();
  const pool = await poolComposition();
  const spend = await getApifySpend(env().APIFY_MONTHLY_CREDIT_USD);
  const dueCount = stats.filter((s) => s.dueForRescan).length;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[20px] leading-tight font-semibold">Competitors</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            {self
              ? `Discovered from @${self.handle}'s most-used hashtags, refreshed by the weekly niche pass.`
              : 'Discovered automatically once your own account is synced.'}
          </p>
        </div>
        <AddCompetitorForm />
      </header>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Pool" />
          <PoolWarning warning={pool.warning} />
          <div className="grid grid-cols-3 divide-x divide-line">
            <Stat label="Accounts" value={formatNumber(stats.length)} />
            <Stat label="Posts held" value={formatNumber(pool.totalPosts)} />
            <Stat
              label="Due for rescan"
              value={dueCount}
              tone={dueCount > 0 ? 'signal' : 'neutral'}
            />
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="Scraping budget"
            aside={
              <Badge tone={spend.remainingUsd > 0 ? 'neutral' : 'bad'}>
                {formatUsd(spend.remainingUsd)} left
              </Badge>
            }
          />
          <div className="px-4 py-3 text-[12px] text-ink-muted">
            Competitors are the only thing v2 scrapes — your own posts, insights and comments come
            from the Graph API for free. Adding or rescanning an account spends from{' '}
            {formatUsd(spend.monthlyAllowanceUsd)} a month; {formatUsd(spend.spentUsd)} is gone so
            far. A scan that would overrun the allowance is refused, not truncated.
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Accounts" />
        {stats.length === 0 ? (
          <Empty
            title="No competitors yet."
            detail="The weekly niche pass discovers them from your hashtags — or add one by handle above."
          />
        ) : (
          <Table
            head={[
              'Handle',
              'Followers',
              'Posts held',
              'Median eng.',
              'Newest post',
              'Discovered via',
              'Last scanned',
              '',
            ]}
          >
            {stats.map((row) => (
              <tr key={row.account.id}>
                <td className="px-4 py-2 font-mono">@{row.account.handle}</td>
                <td className="px-4 py-2">
                  <Metric value={row.account.followers} />
                </td>
                <td className="px-4 py-2">
                  <span className={row.postsHeld < 5 ? 'metric text-ink-faint' : 'metric'}>
                    {row.postsHeld}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <Metric value={row.medianEngagement} />
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-ink-muted">
                  {row.newestPost ? formatRiyadh(row.newestPost, { dateStyle: 'medium' }) : '—'}
                </td>
                <td className="px-4 py-2">
                  {row.account.discoveredViaHashtag ? (
                    <Badge tone="info">#{row.account.discoveredViaHashtag}</Badge>
                  ) : (
                    <Badge tone="neutral">added by hand</Badge>
                  )}
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-ink-muted">
                  {formatRelative(row.account.lastScrapedAt)}
                  {row.dueForRescan ? (
                    <Badge className="ml-2" tone="signal">
                      due
                    </Badge>
                  ) : null}
                </td>
                <td className="px-4 py-2">
                  <CompetitorRowActions id={row.account.id} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      <p className="mt-3 text-[11px] text-ink-faint">
        An account with only a handful of posts held moves the pool&rsquo;s sample size without
        contributing much to it, and one last scanned weeks ago is being compared against on numbers
        that have since moved. Both are called out above rather than left to be inferred from a
        handle and a follower count.
      </p>
    </div>
  );
}
