import { poolComposition } from '@/lib/analysis/corpus';
import { listAccounts, selfAccount } from '@/lib/ingest/upsert';
import { Badge, Empty, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { PoolWarning, Table } from '@/components/ui/data';
import { formatNumber, formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function CompetitorsPage(): Promise<React.JSX.Element> {
  const self = await selfAccount();
  const competitors = await listAccounts('competitor');
  const pool = await poolComposition();

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5">
        <h1 className="text-[20px] leading-tight font-semibold">Competitors</h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          {self
            ? `Discovered automatically from @${self.handle}'s most-used hashtags, ranked by engagement.`
            : 'Discovered automatically once a self account is scanned.'}
        </p>
      </header>

      <Panel className="mb-4">
        <PanelHeader title="Pool" />
        <PoolWarning warning={pool.warning} />
        <div className="grid grid-cols-2 divide-x divide-line">
          <Stat label="Competitor accounts" value={formatNumber(competitors.length)} />
          <Stat label="Total posts in pool" value={formatNumber(pool.totalPosts)} />
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Accounts" />
        {competitors.length === 0 ? (
          <Empty
            title="No competitors discovered yet."
            detail="Scan your own account from the dashboard — competitor discovery runs automatically afterward."
          />
        ) : (
          <Table head={['Handle', 'Followers', 'Discovered via', 'Last scanned']}>
            {competitors.map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-2 font-mono">@{c.handle}</td>
                <td className="metric px-4 py-2">{formatNumber(c.followers)}</td>
                <td className="px-4 py-2">
                  {c.discoveredViaHashtag ? (
                    <Badge tone="info">#{c.discoveredViaHashtag}</Badge>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-ink-muted">{formatRelative(c.lastScrapedAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
