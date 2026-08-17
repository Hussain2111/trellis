import { desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { hookLabels, postFeatures, posts } from '@/lib/db/schema';
import { selfAccount } from '@/lib/ingest/upsert';
import { summariseByFormat } from '@/lib/analysis/features';
import { Badge, Empty, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { Table } from '@/components/ui/data';
import { formatNumber, formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function PostsPage(): Promise<React.JSX.Element> {
  const self = await selfAccount();

  if (!self) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-6">
        <Panel>
          <PanelHeader title="Posts" />
          <Empty
            title="No account scanned yet."
            detail="Scan an Instagram handle from the dashboard first."
          />
        </Panel>
      </div>
    );
  }

  const rows = await db()
    .select({
      post: posts,
      isOutlier: postFeatures.isOutlier,
      engagementRate: postFeatures.engagementRate,
      hasCta: postFeatures.hasCta,
      hasQuestion: postFeatures.hasQuestion,
      hookCategory: hookLabels.category,
    })
    .from(posts)
    .leftJoin(postFeatures, eq(postFeatures.postId, posts.id))
    .leftJoin(hookLabels, eq(hookLabels.postId, posts.id))
    .where(eq(posts.accountId, self.id))
    .orderBy(desc(posts.takenAt));

  const byFormat = summariseByFormat(
    rows.map((r) => r.post),
    self.followers,
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5">
        <h1 className="text-[20px] leading-tight font-semibold">@{self.handle} · Posts</h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          {formatNumber(rows.length)} posts held · last scanned {formatRelative(self.lastScrapedAt)}
        </p>
      </header>

      {byFormat.length > 0 ? (
        <Panel className="mb-4">
          <PanelHeader title="By format" />
          <div
            className="grid divide-x divide-line"
            style={{ gridTemplateColumns: `repeat(${byFormat.length}, 1fr)` }}
          >
            {byFormat.map((f) => (
              <Stat
                key={f.type}
                label={`${f.type} (${f.count})`}
                value={formatNumber(f.medianLikes)}
                sub={`median likes · ${(f.medianEngagementRate * 100).toFixed(1)}% eng.`}
              />
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader title="All posts" />
        {rows.length === 0 ? (
          <Empty title="No posts yet." detail="Run a scan from the dashboard." />
        ) : (
          <Table head={['Posted', 'Type', 'Likes', 'Comments', 'Eng.', 'Hook', 'Flags']}>
            {rows.map((r) => (
              <tr key={r.post.id}>
                <td className="px-4 py-2 whitespace-nowrap text-ink-muted">
                  {r.post.takenAt ? new Date(r.post.takenAt).toLocaleDateString() : '—'}
                </td>
                <td className="px-4 py-2 font-mono">{r.post.type}</td>
                <td className="metric px-4 py-2">{formatNumber(r.post.likes)}</td>
                <td className="metric px-4 py-2">{formatNumber(r.post.comments)}</td>
                <td className="metric px-4 py-2">
                  {r.engagementRate !== null ? `${(r.engagementRate * 100).toFixed(1)}%` : '—'}
                </td>
                <td className="max-w-xs truncate px-4 py-2 text-ink-muted">
                  {r.hookCategory ? r.hookCategory.replace(/_/g, ' ') : '—'}
                </td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-1">
                    {r.isOutlier ? <Badge tone="signal">winner</Badge> : null}
                    {r.hasCta ? <Badge tone="good">cta</Badge> : null}
                    {r.hasQuestion ? <Badge tone="info">question</Badge> : null}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
