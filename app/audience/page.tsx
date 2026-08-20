import { selfAccount } from '@/lib/ingest/upsert';
import { audienceSummary, mostActiveFollowers, repeatBreakdown } from '@/lib/analytics/audience';
import { Empty, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { Table } from '@/components/ui/data';
import { formatRiyadh } from '@/lib/time';

export const dynamic = 'force-dynamic';

function daysCovered(oldest: Date): number {
  return Math.max(1, Math.round((Date.now() - oldest.getTime()) / 86_400_000));
}

export default async function AudiencePage(): Promise<React.JSX.Element> {
  const self = await selfAccount();

  if (!self) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-6">
        <Panel>
          <PanelHeader title="Most active followers" />
          <Empty
            title="No account configured yet."
            detail="Enter your Instagram handle on the dashboard, then connect the Graph API."
          />
        </Panel>
      </div>
    );
  }

  const followers = await mostActiveFollowers(self.id);
  const summary = await audienceSummary(self.id);
  const repeat = repeatBreakdown(followers);

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5">
        <h1 className="text-[20px] leading-tight font-semibold">Most active followers</h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          Who actually talks to you, across the comments held on your {summary.postsWithComments}{' '}
          most recently synced {summary.postsWithComments === 1 ? 'post' : 'posts'}.
        </p>
      </header>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="What's held" />
          <div className="grid grid-cols-3 divide-x divide-line">
            <Stat label="Comments" value={summary.totalComments} />
            <Stat label="People" value={summary.uniqueCommenters} />
            <Stat label="Posts talked about" value={summary.postsWithComments} />
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="How repeat it is" />
          <div className="grid grid-cols-3 divide-x divide-line">
            <Stat label="Commented once" value={repeat.oneOff} />
            <Stat label="2–4 times" value={repeat.occasional} />
            <Stat label="5+ times" value={repeat.regular} tone="signal" />
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Ranked by comments" />
        <div className="border-b border-line bg-signal/[0.06] px-4 py-2 text-[12px] text-signal/90">
          <p>
            This ranks <strong>commenters</strong>, not engaged followers generally. The Graph API
            exposes who commented but not who liked or saved, so someone who likes every post and
            never types does not appear here at all.
            {summary.undated > 0
              ? ` ${summary.undated} comment(s) carry no timestamp and sit outside every window.`
              : ''}
          </p>
          <p className="mt-1">
            The ranking window is {summary.windowDays} days, but that is a ceiling rather than a
            promise: each sync pulls comments for your most recent posts only, so the real coverage
            is{' '}
            {summary.oldestComment
              ? `${formatRiyadh(summary.oldestComment, { dateStyle: 'medium' })} onward — ${daysCovered(summary.oldestComment)} day(s), across ${summary.postsWithComments} post(s).`
              : 'nothing yet.'}{' '}
            Someone who commented before that is not missing from the ranking because they went
            quiet; they were never fetched.
          </p>
        </div>
        {followers.length === 0 ? (
          <Empty
            title="No comments held yet."
            detail="The daily Graph API sync pulls comments on your recent posts."
          />
        ) : (
          <Table head={['#', 'Who', 'Comments', 'On posts', 'First', 'Most recent']}>
            {followers.map((follower, i) => (
              <tr key={follower.username}>
                <td className="metric px-4 py-2 text-ink-faint">{i + 1}</td>
                <td className="px-4 py-2 font-mono">@{follower.username}</td>
                <td className="metric px-4 py-2">{follower.comments}</td>
                <td className="metric px-4 py-2">{follower.postsCommentedOn}</td>
                <td className="px-4 py-2 whitespace-nowrap text-ink-muted">
                  {follower.firstSeen
                    ? formatRiyadh(follower.firstSeen, { dateStyle: 'medium' })
                    : '—'}
                </td>
                <td className="px-4 py-2 whitespace-nowrap text-ink-muted">
                  {follower.lastSeen
                    ? formatRiyadh(follower.lastSeen, { dateStyle: 'medium' })
                    : '—'}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
