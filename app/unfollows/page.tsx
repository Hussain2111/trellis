import { env } from '@/lib/env';
import { selfAccount } from '@/lib/ingest/upsert';
import { estimateCost } from '@/lib/ingest/budget';
import { followerHistory, latestSnapshotDiff, listSnapshots } from '@/lib/insights/followers';
import { Badge, Empty, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { Table } from '@/components/ui/data';
import { Metric } from '@/components/ui/metric';
import { SnapshotButton } from '@/components/follower-snapshot';
import { formatRiyadh } from '@/lib/time';

export const dynamic = 'force-dynamic';

const SNAPSHOT_LIMIT = 2000;

function Change({ value }: { value: number | null }): React.JSX.Element {
  if (value == null) return <span className="text-ink-faint">—</span>;
  const tone = value > 0 ? 'text-positive' : value < 0 ? 'text-negative' : 'text-ink-muted';
  return (
    <span className={`metric ${tone}`}>
      {value > 0 ? '+' : ''}
      {value}
    </span>
  );
}

export default async function UnfollowsPage(): Promise<React.JSX.Element> {
  const self = await selfAccount();

  if (!self) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-6">
        <Panel>
          <PanelHeader title="Unfollows" />
          <Empty
            title="No account configured yet."
            detail="Enter your Instagram handle on the dashboard, then connect the Graph API."
          />
        </Panel>
      </div>
    );
  }

  const e = env();
  const history = await followerHistory(30);
  const snapshots = await listSnapshots(self.id);
  const diff = await latestSnapshotDiff(self.id);
  const estimate = await estimateCost(SNAPSHOT_LIMIT, e.APIFY_MONTHLY_CREDIT_USD);

  const latest = history[0];
  // Sum only the days whose change is actually known. With no known changes
  // there is nothing to add up — and 0 would read as "you held steady", which
  // is a different claim from "we have one reading".
  const knownChanges = history.map((h) => h.change).filter((c): c is number => c != null);
  const net30 = knownChanges.length > 0 ? knownChanges.reduce((sum, c) => sum + c, 0) : null;
  const anyBreakdown = history.some((h) => h.follows != null || h.unfollows != null);
  const reason = history.find((h) => h.unavailableReason)?.unavailableReason ?? null;

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5">
        <h1 className="text-[20px] leading-tight font-semibold">Unfollows</h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          How many left, free and daily. Who left costs a scrape.
        </p>
      </header>

      <Panel className="mb-4">
        <PanelHeader title="Followers" />
        <div className="grid grid-cols-3 divide-x divide-line">
          <Stat label="Now" value={<Metric value={latest?.followerCount} />} />
          <Stat label="Change yesterday" value={<Change value={latest?.change ?? null} />} />
          <Stat label="Net, last 30 days" value={<Change value={net30} />} />
        </div>
      </Panel>

      <Panel className="mb-4">
        <PanelHeader title="Daily" />
        {!anyBreakdown ? (
          <div className="border-b border-line bg-signal/[0.06] px-4 py-2 text-[12px] text-signal/90">
            Instagram is not serving the gross follows/unfollows breakdown for this account, so
            those columns are blank. Only the net change is known.
            {reason ? ` Reported reason: ${reason}` : ''}
          </div>
        ) : null}
        {history.length === 0 ? (
          <Empty
            title="No daily readings yet."
            detail="The daily Graph API sync records the follower count once per Riyadh day."
          />
        ) : (
          <Table head={['Day', 'Followers', 'Net change', 'Follows', 'Unfollows']}>
            {history.map((row) => (
              <tr key={row.day}>
                <td className="px-4 py-2 whitespace-nowrap text-ink-muted">{row.day}</td>
                <td className="px-4 py-2">
                  <Metric value={row.followerCount} />
                </td>
                <td className="px-4 py-2">
                  <Change value={row.change} />
                </td>
                <td className="px-4 py-2">
                  <Metric value={row.follows} title="Not served by Instagram for this account." />
                </td>
                <td className="px-4 py-2">
                  <Metric value={row.unfollows} title="Not served by Instagram for this account." />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      <Panel>
        <PanelHeader
          title="Who left"
          aside={
            <SnapshotButton
              costNote={estimate.note}
              disabled={e.SCRAPE_MODE !== 'live'}
              disabledReason={
                e.SCRAPE_MODE !== 'live'
                  ? `SCRAPE_MODE is ${e.SCRAPE_MODE} — a snapshot needs a real scrape.`
                  : null
              }
            />
          }
        />
        <div className="border-b border-line px-4 py-2 text-[12px] text-ink-faint">
          Instagram never exposes a follower list, at any price — naming people needs a scrape, so
          this is a button rather than a schedule. A diff needs two snapshots taken at different
          times.
        </div>

        {snapshots.length === 0 ? (
          <Empty
            title="No snapshots yet."
            detail="Take one now to set a baseline, then another later to see who left in between."
          />
        ) : !diff ? (
          <Empty
            title="One snapshot held — that's the baseline."
            detail={`Captured ${formatRiyadh(snapshots[0]!.capturedAt)} with ${snapshots[0]!.count} follower(s). Take another later to see the difference.`}
          />
        ) : (
          <div className="px-4 py-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
              <span>
                {formatRiyadh(diff.from.capturedAt)} → {formatRiyadh(diff.to.capturedAt)}
              </span>
              <Badge tone="bad">{diff.lost.length} left</Badge>
              <Badge tone="good">{diff.gained.length} new</Badge>
            </div>
            {diff.note ? <p className="mb-2 text-[12px] text-negative">{diff.note}</p> : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <div className="label mb-1.5">Unfollowed</div>
                {diff.lost.length === 0 ? (
                  <p className="text-[12px] text-ink-faint">Nobody.</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {diff.lost.map((u) => (
                      <span key={u} className="font-mono text-[11px] text-negative">
                        @{u}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="label mb-1.5">New followers</div>
                {diff.gained.length === 0 ? (
                  <p className="text-[12px] text-ink-faint">Nobody.</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {diff.gained.map((u) => (
                      <span key={u} className="font-mono text-[11px] text-positive">
                        @{u}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
