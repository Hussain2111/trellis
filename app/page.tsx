import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { jobs, posts } from '@/lib/db/schema';
import { env } from '@/lib/env';
import { selfAccount } from '@/lib/ingest/upsert';
import { estimateCost } from '@/lib/ingest/budget';
import { byFormat, postAnalytics, summarise, type PostRow } from '@/lib/analytics/posts';
import { summariseTracker, trackedPosts, CHECKPOINTS } from '@/lib/analytics/tracker';
import { audienceSummary, mostActiveFollowers, repeatBreakdown } from '@/lib/analytics/audience';
import { followerHistory, latestSnapshotDiff, listSnapshots } from '@/lib/insights/followers';
import { Badge, Empty, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { Table } from '@/components/ui/data';
import { CoverageNote, Metric, Percent } from '@/components/ui/metric';
import { ScanForm } from '@/components/scan-form';
import { SnapshotButton } from '@/components/follower-snapshot';
import { PipelineTickPoller } from '@/components/pipeline-tick-poller';
import { formatRiyadh } from '@/lib/time';
import { formatNumber } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * Everything about the managed account, on one page.
 *
 * Post analytics, the tracker, commenters and follower movement used to be
 * four tabs. They are four views of one question — how is this account doing —
 * and splitting them meant answering it took four clicks and a memory of which
 * tab held which number. The remaining tabs are all about *other* accounts
 * (Ideas, Topics, Competitors) or about doing rather than reading (Calendar,
 * Chat), which is why they stay separate.
 *
 * The full post table lives on `/analytics`, off the nav: 130-odd rows is a
 * page of its own, and the dashboard shows the most recent dozen with a link.
 */

const SHOWN_POSTS = 12;
const SHOWN_TRACKED = 8;
const SHOWN_COMMENTERS = 8;
const SHOWN_DAYS = 10;
const SNAPSHOT_LIMIT = 2000;

const TRACKER_TONE = {
  climbing: 'good',
  settled: 'neutral',
  'too new': 'signal',
  'not measured': 'neutral',
} as const;

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

function PostRowCells({ row }: { row: PostRow }): React.JSX.Element {
  return (
    <>
      <td className="px-4 py-2 whitespace-nowrap text-ink-muted">
        {row.post.takenAt ? formatRiyadh(row.post.takenAt, { dateStyle: 'medium' }) : '—'}
      </td>
      <td className="px-4 py-2 font-mono">{row.post.type}</td>
      <td className="px-4 py-2">
        <Metric value={row.reach} />
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
        <Percent value={row.engagementOnReach} />
      </td>
    </>
  );
}

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const self = await selfAccount();

  if (!self) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <PipelineTickPoller />
        <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[20px] leading-tight font-semibold">No account configured yet</h1>
            <p className="mt-1 text-[13px] text-ink-muted">
              Enter your Instagram handle to connect it, then the daily sync keeps it current.
            </p>
          </div>
          <ScanForm />
        </header>
        <Panel>
          <PanelHeader title="Your account" />
          <Empty
            title="Nothing synced yet."
            detail="Posts, insights, comments and follower counts come from the Instagram Graph API — see docs/instagram-setup.md."
          />
        </Panel>
      </div>
    );
  }

  const e = env();

  // One page, many queries — run them together rather than serially.
  const [
    postCountRows,
    recentJobs,
    analytics,
    tracked,
    commenters,
    audience,
    followers,
    snapshots,
    snapshotDiff,
    snapshotEstimate,
  ] = await Promise.all([
    db().execute<{ n: number }>(
      sql`select count(*)::int as n from ${posts} where account_id = ${self.id}`,
    ),
    db()
      .select()
      .from(jobs)
      .orderBy(sql`${jobs.id} desc`)
      .limit(6),
    postAnalytics(self.id, self.followers, 100),
    trackedPosts(self.id, SHOWN_TRACKED),
    mostActiveFollowers(self.id, { limit: SHOWN_COMMENTERS }),
    audienceSummary(self.id),
    followerHistory(SHOWN_DAYS),
    listSnapshots(self.id, 2),
    latestSnapshotDiff(self.id),
    estimateCost(SNAPSHOT_LIMIT, e.APIFY_MONTHLY_CREDIT_USD),
  ]);

  const postCount = postCountRows[0]?.n ?? 0;
  const summary = summarise(analytics);
  const formats = byFormat(analytics);
  const trackerSummary = summariseTracker(tracked);
  const repeat = repeatBreakdown(commenters);

  const latestDay = followers[0];
  const knownChanges = followers.map((f) => f.change).filter((c): c is number => c != null);
  const netChange = knownChanges.length > 0 ? knownChanges.reduce((s, c) => s + c, 0) : null;
  const anyBreakdown = followers.some((f) => f.follows != null || f.unfollows != null);
  const breakdownReason = followers.find((f) => f.unavailableReason)?.unavailableReason ?? null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <PipelineTickPoller />

      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[20px] leading-tight font-semibold">@{self.handle}</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            {formatNumber(self.followers)} followers · {formatNumber(postCount)} posts held
            {self.niche ? ` · ${self.niche}` : ''}
          </p>
        </div>
        <ScanForm />
      </header>

      {/* --- the account at a glance ----------------------------------- */}
      <Panel className="mb-4">
        <PanelHeader title="Right now" />
        <div className="grid grid-cols-2 divide-x divide-line lg:grid-cols-4">
          {/* The daily series may be empty while the current count is known —
              the profile carries it even before the first daily reading. */}
          <Stat
            label="Followers"
            value={<Metric value={latestDay?.followerCount ?? self.followers} />}
            sub={latestDay ? undefined : 'no daily reading yet'}
          />
          <Stat label="Change yesterday" value={<Change value={latestDay?.change ?? null} />} />
          <Stat
            label={`Net, last ${SHOWN_DAYS} days`}
            value={<Change value={netChange} />}
            sub={netChange == null ? 'needs two daily readings' : undefined}
          />
          <Stat
            label="Posts measured"
            value={`${summary.measured}/${analytics.length}`}
            sub="carrying Instagram insights"
          />
        </div>
      </Panel>

      {/* --- how the posts do ------------------------------------------ */}
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Typical post" />
          <div className="grid grid-cols-3 divide-x divide-line">
            <Stat label="Median reach" value={<Metric value={summary.medianReach} />} />
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
                    {/* The medians are over the measured subset, which early on
                        is much smaller. Saying so beats a median of one
                        wearing the authority of seventeen. */}
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

      {/* --- is anything still travelling ------------------------------- */}
      <Panel className="mb-4">
        <PanelHeader
          title="Still going"
          aside={<span className="text-[11px] text-ink-faint">reach at 24h · 48h · 7d · now</span>}
        />
        <div className="grid grid-cols-4 divide-x divide-line border-b border-line">
          <Stat label="Climbing" value={trackerSummary.climbing} tone="good" />
          <Stat label="Settled" value={trackerSummary.settled} />
          <Stat label="Too new to tell" value={trackerSummary.tooNew} tone="signal" />
          <Stat label="Awaiting capture" value={trackerSummary.awaitingCapture} />
        </div>
        {tracked.length === 0 ? (
          <Empty
            title="Nothing to track yet."
            detail="Checkpoints are written as each post passes 24 hours, 48 hours and 7 days old."
          />
        ) : (
          <Table head={['Posted', 'Type', '24h', '48h', '7d', 'Now', '24h → 7d', 'Status']}>
            {tracked.map((row) => (
              <tr key={row.post.id}>
                <td className="px-4 py-2 whitespace-nowrap text-ink-muted">
                  {row.post.takenAt ? formatRiyadh(row.post.takenAt, { dateStyle: 'medium' }) : '—'}
                </td>
                <td className="px-4 py-2 font-mono">{row.post.type}</td>
                {CHECKPOINTS.map((cp) => (
                  <td key={cp} className="px-4 py-2">
                    <Metric value={row.points[cp]?.reach} />
                  </td>
                ))}
                <td className="px-4 py-2">
                  <Metric value={row.points.latest?.reach} />
                </td>
                <td className="px-4 py-2">
                  <Metric value={row.reachGrowth} title="Needs two fixed checkpoints." />
                </td>
                <td className="px-4 py-2">
                  <Badge tone={TRACKER_TONE[row.status]}>{row.status}</Badge>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      {/* --- the posts themselves --------------------------------------- */}
      <Panel className="mb-4">
        <PanelHeader
          title="Recent posts"
          aside={
            <a href="/analytics" className="text-[11px] text-info hover:underline">
              all {formatNumber(analytics.length)} posts →
            </a>
          }
        />
        <CoverageNote measured={summary.measured} total={analytics.length} what="posts" />
        {analytics.length === 0 ? (
          <Empty
            title="No posts yet."
            detail="The daily Graph API sync pulls your posts, their insights and their comments."
          />
        ) : (
          <Table head={['Posted', 'Type', 'Reach', 'Likes', 'Comments', 'Saves', 'Eng.']}>
            {analytics.slice(0, SHOWN_POSTS).map((row) => (
              <tr key={row.post.id}>
                <PostRowCells row={row} />
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      {/* --- the people ------------------------------------------------- */}
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Who talks to you"
            aside={
              <span className="text-[11px] text-ink-faint">
                {repeat.regular} regular · {repeat.occasional} occasional · {repeat.oneOff} once
              </span>
            }
          />
          <div className="border-b border-line bg-signal/[0.06] px-4 py-2 text-[11px] text-signal/90">
            Ranks <strong>commenters</strong> — the Graph API exposes who commented, not who liked,
            so someone who likes everything and never types is invisible here.
            {audience.oldestComment
              ? ` Covers ${formatRiyadh(audience.oldestComment, { dateStyle: 'medium' })} onward, across ${audience.postsWithComments} post(s).`
              : ''}
          </div>
          {commenters.length === 0 ? (
            <Empty
              title="No comments held yet."
              detail="The daily sync pulls comments on your most recent posts."
            />
          ) : (
            <Table head={['Who', 'Comments', 'On posts', 'Most recent']}>
              {commenters.map((c) => (
                <tr key={c.username}>
                  <td className="px-4 py-2 font-mono">@{c.username}</td>
                  <td className="metric px-4 py-2">{c.comments}</td>
                  <td className="metric px-4 py-2">{c.postsCommentedOn}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-ink-muted">
                    {c.lastSeen ? formatRiyadh(c.lastSeen, { dateStyle: 'medium' }) : '—'}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>

        <Panel>
          <PanelHeader
            title="Followers, day by day"
            aside={
              <SnapshotButton
                costNote={snapshotEstimate.note}
                disabled={e.SCRAPE_MODE !== 'live'}
                disabledReason={
                  e.SCRAPE_MODE !== 'live'
                    ? `SCRAPE_MODE is ${e.SCRAPE_MODE} — a snapshot needs a real scrape.`
                    : null
                }
              />
            }
          />
          {!anyBreakdown && followers.length > 0 ? (
            <div className="border-b border-line bg-signal/[0.06] px-4 py-2 text-[11px] text-signal/90">
              Instagram is not serving the gross follows/unfollows breakdown for this account, so
              only the net change is known.
              {breakdownReason ? ` Reported reason: ${breakdownReason}` : ''}
            </div>
          ) : null}
          {followers.length === 0 ? (
            <Empty
              title="No daily readings yet."
              detail="The daily sync records the follower count once per Riyadh day."
            />
          ) : (
            <Table head={['Day', 'Followers', 'Net', 'Follows', 'Unfollows']}>
              {followers.map((f) => (
                <tr key={f.day}>
                  <td className="px-4 py-2 whitespace-nowrap text-ink-muted">{f.day}</td>
                  <td className="px-4 py-2">
                    <Metric value={f.followerCount} />
                  </td>
                  <td className="px-4 py-2">
                    <Change value={f.change} />
                  </td>
                  <td className="px-4 py-2">
                    <Metric value={f.follows} title="Not served by Instagram for this account." />
                  </td>
                  <td className="px-4 py-2">
                    <Metric value={f.unfollows} title="Not served by Instagram for this account." />
                  </td>
                </tr>
              ))}
            </Table>
          )}

          <div className="border-t border-line px-4 py-3 text-[12px]">
            <div className="label mb-1.5">Who left</div>
            {snapshots.length === 0 ? (
              <p className="text-ink-faint">
                Instagram never exposes a follower list, at any price — naming people needs a
                scrape, so it is a button rather than a schedule. Take one to set a baseline.
              </p>
            ) : !snapshotDiff ? (
              <p className="text-ink-faint">
                One snapshot held ({formatNumber(snapshots[0]!.count)} followers, captured{' '}
                {formatRiyadh(snapshots[0]!.capturedAt)}). That is the baseline — take another later
                to see the difference.
              </p>
            ) : (
              <div>
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <Badge tone="bad">{snapshotDiff.lost.length} left</Badge>
                  <Badge tone="good">{snapshotDiff.gained.length} new</Badge>
                  <span className="text-[11px] text-ink-faint">
                    {formatRiyadh(snapshotDiff.from.capturedAt)} →{' '}
                    {formatRiyadh(snapshotDiff.to.capturedAt)}
                  </span>
                </div>
                {snapshotDiff.note ? (
                  <p className="mb-1.5 text-[11px] text-negative">{snapshotDiff.note}</p>
                ) : null}
                <div className="flex flex-wrap gap-1">
                  {snapshotDiff.lost.slice(0, 40).map((u) => (
                    <span key={u} className="font-mono text-[11px] text-negative">
                      @{u}
                    </span>
                  ))}
                  {snapshotDiff.lost.length === 0 ? (
                    <span className="text-[11px] text-ink-faint">Nobody left.</span>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </Panel>
      </div>

      {/* --- the machinery ---------------------------------------------- */}
      <Panel>
        <PanelHeader title="Jobs" />
        {recentJobs.length === 0 ? (
          <Empty
            title="Queue is empty."
            detail="Long operations run here so no HTTP request ever blocks on a model call or a multi-minute scrape."
          />
        ) : (
          <ul className="divide-y divide-line">
            {recentJobs.map((job) => (
              <li key={job.id} className="flex items-center gap-2 px-4 py-2">
                <span className="metric text-[11px] text-ink-faint">#{job.id}</span>
                <span className="font-mono text-[12px]">{job.type}</span>
                {job.progressLabel ? (
                  <span className="truncate text-[11px] text-ink-faint">{job.progressLabel}</span>
                ) : null}
                <Badge
                  className="ml-auto"
                  tone={
                    job.status === 'done'
                      ? 'good'
                      : job.status === 'failed'
                        ? 'bad'
                        : job.status === 'running' ||
                            job.status === 'claimed' ||
                            job.status === 'waiting'
                          ? 'signal'
                          : 'neutral'
                  }
                >
                  {job.status}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
