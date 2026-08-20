import { selfAccount } from '@/lib/ingest/upsert';
import { CHECKPOINTS, summariseTracker, trackedPosts } from '@/lib/analytics/tracker';
import { Badge, Empty, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { Table } from '@/components/ui/data';
import { Metric } from '@/components/ui/metric';
import { formatRiyadh } from '@/lib/time';

export const dynamic = 'force-dynamic';

const STATUS_TONE = {
  climbing: 'good',
  settled: 'neutral',
  'too new': 'signal',
  'not measured': 'neutral',
} as const;

const CHECKPOINT_LABEL = { t24: '24h', t48: '48h', t7d: '7d' } as const;

export default async function TrackerPage(): Promise<React.JSX.Element> {
  const self = await selfAccount();

  if (!self) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <Panel>
          <PanelHeader title="Post tracker" />
          <Empty
            title="No account configured yet."
            detail="Enter your Instagram handle on the dashboard, then connect the Graph API."
          />
        </Panel>
      </div>
    );
  }

  const rows = await trackedPosts(self.id);
  const summary = summariseTracker(rows);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <header className="mb-5">
        <h1 className="text-[20px] leading-tight font-semibold">Post tracker</h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          Reach at 24 hours, 48 hours and 7 days. A post that is still climbing on day three is
          worth a second push; one that settled by hour 24 is not.
        </p>
      </header>

      <Panel className="mb-4">
        <PanelHeader title="Right now" />
        <div className="grid grid-cols-4 divide-x divide-line">
          <Stat label="Still climbing" value={summary.climbing} tone="good" />
          <Stat label="Settled" value={summary.settled} />
          <Stat label="Too new to tell" value={summary.tooNew} tone="signal" />
          <Stat
            label="Awaiting capture"
            value={summary.awaitingCapture}
            sub="next daily sync picks these up"
          />
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Trajectory" />
        {rows.length === 0 ? (
          <Empty
            title="Nothing to track yet."
            detail="Checkpoints are written as each post passes 24 hours, 48 hours and 7 days old."
          />
        ) : (
          <Table
            head={['Posted', 'Type', '24h', '48h', '7d', 'Now', '24h → 7d', 'Since last', 'Status']}
          >
            {rows.map((row) => (
              <tr key={row.post.id}>
                <td className="px-4 py-2 whitespace-nowrap text-ink-muted">
                  {row.post.takenAt ? formatRiyadh(row.post.takenAt, { dateStyle: 'medium' }) : '—'}
                </td>
                <td className="px-4 py-2 font-mono">{row.post.type}</td>
                {CHECKPOINTS.map((checkpoint) => (
                  <td key={checkpoint} className="px-4 py-2">
                    <Metric
                      value={row.points[checkpoint]?.reach}
                      title={
                        row.awaiting === checkpoint
                          ? `Not captured yet — this post reaches ${CHECKPOINT_LABEL[checkpoint]} on the next daily sync.`
                          : 'No reach recorded at this checkpoint.'
                      }
                    />
                  </td>
                ))}
                <td className="px-4 py-2">
                  <Metric value={row.points.latest?.reach} />
                </td>
                <td className="px-4 py-2">
                  <Metric value={row.reachGrowth} title="Needs two fixed checkpoints." />
                </td>
                <td className="px-4 py-2">
                  <Metric
                    value={row.sinceLastCheckpoint}
                    title="Needs a fixed checkpoint and a current reading."
                  />
                </td>
                <td className="px-4 py-2">
                  <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
