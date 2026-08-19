import { hotTopics, MIN_POSTS_FOR_TREND, type Topic } from '@/lib/analytics/topics';
import { Badge, Empty, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { Table } from '@/components/ui/data';
import { Metric } from '@/components/ui/metric';
import { formatNumber } from '@/lib/utils';

export const dynamic = 'force-dynamic';

function Delta({ value }: { value: number | null }): React.JSX.Element {
  if (value == null) return <span className="text-ink-faint">—</span>;
  const tone = value > 0 ? 'text-positive' : value < 0 ? 'text-negative' : 'text-ink-muted';
  return (
    <span className={`metric ${tone}`}>
      {value > 0 ? '+' : ''}
      {value.toFixed(1)}pp
    </span>
  );
}

function TopicRows({ topics }: { topics: Topic[] }): React.JSX.Element {
  return (
    <>
      {topics.map((topic) => (
        <tr key={topic.tag}>
          <td className="px-4 py-2 font-mono text-info">
            #{topic.tag}
            {topic.usedByYou ? (
              <Badge className="ml-2" tone="good">
                you use this
              </Badge>
            ) : null}
          </td>
          <td className="metric px-4 py-2">{topic.recentPosts}</td>
          <td className="metric px-4 py-2 text-ink-faint">{topic.priorPosts}</td>
          <td className="px-4 py-2">
            <Delta value={topic.shareDeltaPct} />
          </td>
          <td className="px-4 py-2">
            <Metric value={topic.medianEngagement} />
          </td>
          <td className="px-4 py-2">
            {topic.performanceRatio == null ? (
              <span className="text-ink-faint">—</span>
            ) : (
              <span
                className={`metric ${topic.performanceRatio >= 1 ? 'text-positive' : 'text-ink-muted'}`}
              >
                {topic.performanceRatio.toFixed(2)}×
              </span>
            )}
          </td>
          <td className="metric px-4 py-2 text-ink-muted">{topic.usedByAccounts}</td>
        </tr>
      ))}
    </>
  );
}

const HEAD = ['Tag', 'Posts now', 'Before', 'Share change', 'Median eng.', 'vs pool', 'Accounts'];

export default async function TopicsPage(): Promise<React.JSX.Element> {
  const result = await hotTopics();

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <header className="mb-5">
        <h1 className="text-[20px] leading-tight font-semibold">Hot topics</h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          What your niche is talking about more than it was, over the last {result.windowDays} days
          against the {result.windowDays} before.
        </p>
      </header>

      <Panel className="mb-4">
        <PanelHeader title="The window" />
        <div className="grid grid-cols-3 divide-x divide-line">
          <Stat label="Posts, recent" value={formatNumber(result.recentPostCount)} />
          <Stat label="Posts, prior" value={formatNumber(result.priorPostCount)} />
          <Stat
            label="Pool median eng."
            value={<Metric value={result.poolMedianEngagement} />}
            sub="the 1.00× line"
          />
        </div>
      </Panel>

      <div className="mb-4 rounded-[3px] border border-line bg-surface-2/40 px-4 py-3 text-[12px] text-ink-muted">
        <span className="label mr-2">how this is measured</span>
        Movement is in <strong>share of posts</strong>, not raw counts — a window where the pool
        simply posted more would inflate every count and make everything look like it was rising.
        Nothing here is a model&rsquo;s opinion about what is trending: a tag rises because it
        appears in a larger share of posts than it did, which is countable. Tags used in fewer than{' '}
        {MIN_POSTS_FOR_TREND} posts are left out as noise.
      </div>

      <Panel className="mb-4">
        <PanelHeader title="Rising" aside={<Badge tone="signal">by share change</Badge>} />
        {result.rising.length === 0 ? (
          <Empty
            title="Nothing is rising."
            detail="Either there is no prior window to compare against yet, or no tag gained share. The weekly niche scan refreshes this."
          />
        ) : (
          <Table head={HEAD}>
            <TopicRows topics={result.rising} />
          </Table>
        )}
      </Panel>

      <Panel>
        <PanelHeader
          title="Performing best"
          aside={<Badge tone="neutral">by engagement vs the pool</Badge>}
        />
        {result.strongest.length === 0 ? (
          <Empty
            title="Nothing to rank yet."
            detail="Needs competitor posts in the recent window with engagement recorded."
          />
        ) : (
          <Table head={HEAD}>
            <TopicRows topics={result.strongest} />
          </Table>
        )}
      </Panel>
    </div>
  );
}
