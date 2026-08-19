import { hooksAmongIdeas, ideas, MIN_POSTS_FOR_BASELINE } from '@/lib/analytics/ideas';
import { Badge, Empty, Panel, PanelHeader } from '@/components/ui/primitives';
import { formatRiyadh } from '@/lib/time';
import { formatNumber } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function IdeasPage(): Promise<React.JSX.Element> {
  const { ideas: list, skippedAccounts, windowDays } = await ideas();
  const hooks = hooksAmongIdeas(list);

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5">
        <h1 className="text-[20px] leading-tight font-semibold">Ideas</h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          Posts from your niche that beat their own account&rsquo;s normal by the widest margin, in
          the last {windowDays} days.
        </p>
      </header>

      <div className="mb-4 rounded-[3px] border border-line bg-surface-2/40 px-4 py-3 text-[12px] text-ink-muted">
        <span className="label mr-2">how the score works</span>
        Engagement on the post ÷ that account&rsquo;s own median engagement. A score of 4 means the
        post did four times what that account usually does — the same claim whether the account has
        5,000 followers or 500,000. Ranking by raw likes would just rank accounts by size and bury
        every genuine breakout from a small one.
      </div>

      {hooks.length > 0 ? (
        <Panel className="mb-4">
          <PanelHeader title="Hooks these breakouts used" />
          <div className="flex flex-wrap gap-1.5 px-4 py-3">
            {hooks.map((h) => (
              <Badge key={h.category} tone={h.count > 1 ? 'signal' : 'neutral'}>
                {h.category.replace(/_/g, ' ')} · {h.count}
              </Badge>
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader title="Ranked by how far they beat their baseline" />
        {skippedAccounts.length > 0 ? (
          <div className="border-b border-line bg-signal/[0.06] px-4 py-2 text-[12px] text-signal/90">
            {skippedAccounts.length} account(s) are excluded for having fewer than{' '}
            {MIN_POSTS_FOR_BASELINE} posts held — below that, an account&rsquo;s median is noise and
            the ratio would mean nothing:{' '}
            {skippedAccounts.map((a) => `@${a.handle} (${a.posts})`).join(', ')}.
          </div>
        ) : null}

        {list.length === 0 ? (
          <Empty
            title="No breakouts found."
            detail="Either the competitor pool is empty, or nothing in it has meaningfully outperformed its own baseline lately. The weekly niche scan refreshes this."
          />
        ) : (
          <ul className="divide-y divide-line">
            {list.map((idea) => (
              <li key={idea.post.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="metric text-[15px] text-signal">
                    {idea.viralScore.toFixed(1)}×
                  </span>
                  <span className="font-mono text-[12px] text-ink">@{idea.handle}</span>
                  <Badge tone="neutral">{idea.post.type}</Badge>
                  {idea.hookCategory ? (
                    <Badge tone="info">{idea.hookCategory.replace(/_/g, ' ')}</Badge>
                  ) : null}
                  <span className="text-[11px] text-ink-faint">
                    {formatNumber(idea.engagement)} vs their usual {formatNumber(idea.baseline)}
                  </span>
                  {idea.post.takenAt ? (
                    <span className="ml-auto text-[11px] text-ink-faint">
                      {formatRiyadh(idea.post.takenAt, { dateStyle: 'medium' })}
                    </span>
                  ) : null}
                </div>
                {idea.post.caption ? (
                  <p className="mt-1.5 line-clamp-3 text-[12px] whitespace-pre-wrap text-ink-muted">
                    {idea.post.caption}
                  </p>
                ) : null}
                <a
                  className="mt-1.5 inline-block font-mono text-[11px] text-info hover:underline"
                  href={
                    idea.post.permalink ?? `https://www.instagram.com/p/${idea.post.shortcode}/`
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  {idea.post.shortcode} ↗
                </a>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
