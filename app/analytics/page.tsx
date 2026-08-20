import { selfAccount } from '@/lib/ingest/upsert';
import { byFormat, postAnalytics, summarise } from '@/lib/analytics/posts';
import { Empty, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { Table } from '@/components/ui/data';
import { CoverageNote, Metric, Percent } from '@/components/ui/metric';
import { formatRiyadh } from '@/lib/time';
import { formatNumber } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage(): Promise<React.JSX.Element> {
  const self = await selfAccount();

  if (!self) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <Panel>
          <PanelHeader title="Post analytics" />
          <Empty
            title="No account configured yet."
            detail="Enter your Instagram handle on the dashboard, then connect the Graph API — see docs/instagram-setup.md."
          />
        </Panel>
      </div>
    );
  }

  const rows = await postAnalytics(self.id, self.followers);
  const summary = summarise(rows);
  const formats = byFormat(rows);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <header className="mb-5">
        <h1 className="text-[20px] leading-tight font-semibold">Post analytics</h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          What each post actually did — reach, saves and shares straight from Instagram, not
          inferred from likes.
        </p>
      </header>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Typical post" />
          <div className="grid grid-cols-3 divide-x divide-line">
            <Stat
              label="Median reach"
              value={<Metric value={summary.medianReach} />}
              sub={`${summary.measured} measured`}
            />
            <Stat
              label="Median eng."
              value={<Percent value={summary.medianEngagementOnReach} />}
              sub="interactions ÷ reach"
            />
            <Stat label="Saves" value={<Metric value={summary.totalSaves} />} sub="total held" />
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="By format" />
          {formats.length === 0 ? (
            <Empty title="Nothing to break down yet." detail="Sync the account first." />
          ) : (
            <Table head={['Format', 'Posts', 'Median reach', 'Median eng.']}>
              {formats.map((f) => (
                <tr key={f.type}>
                  <td className="px-4 py-2 font-mono">{f.type}</td>
                  <td className="px-4 py-2">
                    <span className="metric">{f.count}</span>
                    {f.measuredCount !== f.count ? (
                      <span className="ml-1 text-[11px] text-ink-faint">
                        ({f.measuredCount} measured)
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2">
                    <Metric value={f.medianReach} />
                  </td>
                  <td className="px-4 py-2">
                    <Percent value={f.medianEngagementOnReach} />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>

      <Panel>
        <PanelHeader
          title="Every post"
          aside={
            <span className="text-[11px] text-ink-faint">{formatNumber(rows.length)} held</span>
          }
        />
        <CoverageNote measured={summary.measured} total={rows.length} what="posts" />
        {rows.length === 0 ? (
          <Empty
            title="No posts yet."
            detail="The daily Graph API sync pulls your posts, their insights and their comments."
          />
        ) : (
          <Table
            head={[
              'Posted',
              'Type',
              'Reach',
              'Views',
              'Likes',
              'Comments',
              'Saves',
              'Shares',
              'Eng.',
            ]}
          >
            {rows.map((row) => (
              <tr key={row.post.id}>
                <td className="px-4 py-2 whitespace-nowrap text-ink-muted">
                  {row.post.takenAt ? formatRiyadh(row.post.takenAt, { dateStyle: 'medium' }) : '—'}
                </td>
                <td className="px-4 py-2 font-mono">{row.post.type}</td>
                <td className="px-4 py-2">
                  <Metric value={row.reach} />
                </td>
                <td className="px-4 py-2">
                  <Metric value={row.views} />
                </td>
                <td className="px-4 py-2">
                  <Metric value={row.post.likes} />
                </td>
                <td className="px-4 py-2">
                  <Metric value={row.post.comments} />
                </td>
                <td className="px-4 py-2">
                  <Metric value={row.saves} />
                </td>
                <td className="px-4 py-2">
                  <Metric value={row.shares} />
                </td>
                <td className="px-4 py-2">
                  <Percent value={row.engagementOnReach} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
