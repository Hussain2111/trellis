import Link from 'next/link';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { accounts, postFeatures, posts } from '@/lib/db/schema';
import { labelsForPosts } from '@/lib/analysis/archetypes';
import { summariseByFormat, cadenceByWeek } from '@/lib/analysis/features';
import { selfAccount } from '@/lib/ingest/upsert';
import { getSettings } from '@/lib/settings';
import { Badge, Empty, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { Bar, Table } from '@/components/ui/data';
import { ActionButton } from '@/components/action-button';
import { runJobAction, scanAccountAction } from '../actions';
import { formatNumber, formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function PostsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; sort?: string; outliers?: string }>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const self = selfAccount();
  const settings = getSettings();

  if (!self) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-6">
        <h1 className="mb-4 text-[20px] font-semibold">Posts</h1>
        <Panel>
          <Empty
            title="No account marked as yours."
            detail="Add your handle in Settings, then scan it. Everything downstream needs a corpus to work from."
          />
        </Panel>
      </div>
    );
  }

  const rows = db()
    .select({ post: posts, features: postFeatures })
    .from(posts)
    .leftJoin(postFeatures, eq(postFeatures.postId, posts.id))
    .where(eq(posts.accountId, self.id))
    .orderBy(params.sort === 'top' ? desc(posts.likes) : desc(posts.takenAt))
    .all();

  const filtered = rows.filter(
    (r) =>
      (!params.type || params.type === 'all' || r.post.type === params.type) &&
      (params.outliers !== '1' || r.features?.isOutlier),
  );

  const labels = new Map(
    labelsForPosts(filtered.slice(0, 200).map((r) => r.post.id)).map((l) => [l.postId, l.name]),
  );
  const byFormat = summariseByFormat(rows.map((r) => r.post), self.followers);
  const cadence = cadenceByWeek(rows.map((r) => r.post), 12);
  const maxWeek = Math.max(1, ...cadence.map((c) => c.total));
  const outlierCount = rows.filter((r) => r.features?.isOutlier).length;
  const transcribed = rows.filter((r) => r.features?.spokenHook).length;

  const types = ['all', 'reel', 'carousel', 'image', 'video'];

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] leading-tight font-semibold">@{self.handle}</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            {formatNumber(rows.length)} posts · {formatNumber(self.followers)} followers · last
            scanned {formatRelative(self.lastScrapedAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton
            action={scanAccountAction.bind(null, self.id, 100)}
            label="scan"
            confirm={`Scan @${self.handle}? This spends Apify credits unless SCRAPE_MODE is fixture or fake.`}
          />
          <ActionButton action={runJobAction.bind(null, 'compute_features')} label="recompute features" />
          <ActionButton action={runJobAction.bind(null, 'transcribe_reels')} label="transcribe reels" />
        </div>
      </header>

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <PanelHeader title="By format" />
          <Table head={['format', 'n', 'median likes', 'median comments', 'median views', 'median ER']}>
            {byFormat.map((f) => (
              <tr key={f.type}>
                <td className="px-4 py-1.5 font-mono">{f.type}</td>
                <td className="px-4 py-1.5 tabular">{f.count}</td>
                <td className="px-4 py-1.5 tabular">{formatNumber(f.medianLikes)}</td>
                <td className="px-4 py-1.5 tabular">{formatNumber(f.medianComments)}</td>
                <td className="px-4 py-1.5 tabular">
                  {f.medianViews === null ? '—' : formatNumber(f.medianViews)}
                </td>
                <td className="px-4 py-1.5 tabular">
                  {(f.medianEngagementRate * 100).toFixed(2)}%
                </td>
              </tr>
            ))}
          </Table>
        </Panel>

        <Panel>
          <PanelHeader title="Signal" />
          <div className="grid grid-cols-2 divide-x divide-line border-b border-line">
            <Stat
              label="My winners"
              value={<span className="tabular">{outlierCount}</span>}
              tone="signal"
              sub={`≥ ${settings.outlierMultiplier}× trailing median`}
            />
            <Stat
              label="Spoken hooks"
              value={<span className="tabular">{transcribed}</span>}
              sub={transcribed === 0 ? 'run transcription' : 'from reel audio'}
            />
          </div>
          <div className="px-4 py-3">
            <div className="label mb-2">Cadence, last 12 weeks</div>
            <div className="flex items-end gap-1">
              {cadence.map((c) => (
                <div key={c.weekStart} className="flex-1" title={`${c.total} posts`}>
                  <div
                    className="w-full bg-signal/70"
                    style={{ height: `${Math.max(2, (c.total / maxWeek) * 44)}px` }}
                  />
                </div>
              ))}
            </div>
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader
          title={`Posts (${filtered.length})`}
          aside={
            <div className="flex items-center gap-1">
              {types.map((t) => (
                <Link
                  key={t}
                  href={`/posts?type=${t}${params.sort ? `&sort=${params.sort}` : ''}${params.outliers === '1' ? '&outliers=1' : ''}`}
                  className={
                    (params.type ?? 'all') === t
                      ? 'rounded-[3px] bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink'
                      : 'rounded-[3px] px-2 py-0.5 font-mono text-[11px] text-ink-faint hover:text-ink'
                  }
                >
                  {t}
                </Link>
              ))}
              <span className="mx-1 h-3 w-px bg-line-strong" />
              <Link
                href={`/posts?type=${params.type ?? 'all'}&sort=${params.sort === 'top' ? 'recent' : 'top'}${params.outliers === '1' ? '&outliers=1' : ''}`}
                className="rounded-[3px] px-2 py-0.5 font-mono text-[11px] text-ink-faint hover:text-ink"
              >
                {params.sort === 'top' ? 'by date' : 'by likes'}
              </Link>
              <Link
                href={`/posts?type=${params.type ?? 'all'}${params.sort ? `&sort=${params.sort}` : ''}${params.outliers === '1' ? '' : '&outliers=1'}`}
                className={
                  params.outliers === '1'
                    ? 'rounded-[3px] bg-signal/15 px-2 py-0.5 font-mono text-[11px] text-signal'
                    : 'rounded-[3px] px-2 py-0.5 font-mono text-[11px] text-ink-faint hover:text-ink'
                }
              >
                winners
              </Link>
            </div>
          }
        />
        {filtered.length === 0 ? (
          <Empty
            title="Nothing here."
            detail="Either the filter is too narrow, or this account has not been scanned yet."
          />
        ) : (
          <Table head={['when', 'type', 'hook', 'archetype', 'likes', 'comments', 'ER', '']}>
            {filtered.slice(0, 200).map(({ post, features }) => (
              <tr key={post.id} className={features?.isOutlier ? 'bg-signal/[0.04]' : ''}>
                <td className="px-4 py-1.5 whitespace-nowrap text-ink-faint">
                  {formatRelative(post.takenAt)}
                </td>
                <td className="px-4 py-1.5 font-mono">{post.type}</td>
                <td className="max-w-[26rem] truncate px-4 py-1.5">
                  {features?.hookText || features?.firstLine || '—'}
                </td>
                <td className="px-4 py-1.5 text-ink-muted">{labels.get(post.id) ?? '—'}</td>
                <td className="px-4 py-1.5 tabular">{formatNumber(post.likes)}</td>
                <td className="px-4 py-1.5 tabular">{formatNumber(post.comments)}</td>
                <td className="px-4 py-1.5 tabular">
                  {features?.engagementRate ? `${(features.engagementRate * 100).toFixed(2)}%` : '—'}
                </td>
                <td className="px-4 py-1.5">
                  {features?.isOutlier ? <Badge tone="signal">winner</Badge> : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
        {filtered.length > 200 ? (
          <div className="border-t border-line px-4 py-2 text-[11px] text-ink-faint">
            Showing the first 200 of {filtered.length}.
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

export async function generateMetadata() {
  const self = db().select().from(accounts).where(eq(accounts.role, 'self')).get();
  return { title: self ? `Posts · @${self.handle}` : 'Posts' };
}
