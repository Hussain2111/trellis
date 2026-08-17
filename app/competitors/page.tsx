import { sql, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { posts } from '@/lib/db/schema';
import {
  benchmarkByFormat,
  benchmarkTraits,
  loadCorpus,
  poolComposition,
} from '@/lib/analysis/benchmark';
import { listAccounts } from '@/lib/ingest/upsert';
import { Badge, Button, Empty, Input, Panel, PanelHeader, Select } from '@/components/ui/primitives';
import { Delta, PoolWarning, Share, Table } from '@/components/ui/data';
import { ActionButton } from '@/components/action-button';
import { ActionForm } from '@/components/action-form';
import { addAccountAction, removeAccountAction, scanAccountAction } from '../actions';
import { formatNumber, formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function CompetitorsPage(): Promise<React.JSX.Element> {
  const all = listAccounts();
  const competitors = all.filter((a) => a.role === 'competitor');
  const corpus = loadCorpus();
  const pool = poolComposition(corpus);
  const formats = benchmarkByFormat(corpus);
  const traits = benchmarkTraits(corpus);

  const postCounts = new Map(
    db()
      .select({ accountId: posts.accountId, n: sql<number>`count(*)` })
      .from(posts)
      .groupBy(posts.accountId)
      .all()
      .map((r) => [r.accountId, Number(r.n)] as const),
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-1">
        <h1 className="text-[20px] font-semibold">Competitors</h1>
        <p className="mt-1 mb-5 max-w-2xl text-[13px] text-ink-muted">
          Curated by hand on purpose. Hashtag discovery burns scraping credits guessing at
          something you already know — and ten badly chosen accounts produce confident nonsense.
        </p>
      </header>

      <Panel className="mb-4">
        <PanelHeader title="Add an account" />
        <ActionForm action={addAccountAction} className="flex flex-wrap items-end gap-3 px-4 py-4">
          <div className="min-w-[16rem] flex-1">
            <span className="label mb-1.5 block">Handle</span>
            <Input name="handle" placeholder="someone" />
          </div>
          <div className="w-40">
            <span className="label mb-1.5 block">Role</span>
            <Select name="role" defaultValue="competitor">
              <option value="competitor">competitor</option>
              <option value="self">mine</option>
            </Select>
          </div>
          <Button variant="primary" type="submit">
            Add
          </Button>
        </ActionForm>
      </Panel>

      <Panel className="mb-4">
        <PanelHeader
          title={`Pool (${competitors.length} accounts, ${pool.totalPosts} posts)`}
          aside={
            pool.thin ? <Badge tone="signal">thin</Badge> : <Badge tone="good">workable</Badge>
          }
        />
        <PoolWarning warning={pool.warning} />
        {all.length === 0 ? (
          <Empty
            title="Nothing tracked yet."
            detail="Add your own handle first, then five to fifteen accounts you consider your niche."
          />
        ) : (
          <Table head={['handle', 'role', 'followers', 'posts held', 'last scan', '']}>
            {all.map((account) => (
              <tr key={account.id}>
                <td className="px-4 py-1.5 font-mono">@{account.handle}</td>
                <td className="px-4 py-1.5">
                  {account.role === 'self' ? (
                    <Badge tone="signal">mine</Badge>
                  ) : (
                    <span className="text-ink-faint">competitor</span>
                  )}
                </td>
                <td className="px-4 py-1.5 tabular">{formatNumber(account.followers)}</td>
                <td className="px-4 py-1.5 tabular">{postCounts.get(account.id) ?? 0}</td>
                <td className="px-4 py-1.5 text-ink-faint">
                  {formatRelative(account.lastScrapedAt)}
                </td>
                <td className="px-4 py-1.5">
                  <span className="flex items-center justify-end gap-2">
                    <ActionButton
                      action={scanAccountAction.bind(null, account.id, 100)}
                      label="scan"
                      confirm={`Scan @${account.handle}? This spends Apify credits unless SCRAPE_MODE is fixture or fake.`}
                    />
                    {account.role === 'competitor' ? (
                      <ActionButton
                        action={removeAccountAction.bind(null, account.id)}
                        label="remove"
                        variant="ghost"
                        confirm={`Remove @${account.handle} and everything scraped from it?`}
                      />
                    ) : null}
                  </span>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      {pool.totalPosts > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel>
            <PanelHeader title="Format mix — me vs niche" />
            <PoolWarning warning={pool.warning} />
            <Table head={['format', 'me', 'niche', 'delta']}>
              {formats.map((f) => (
                <tr key={f.type}>
                  <td className="px-4 py-1.5 font-mono">{f.type}</td>
                  <td className="px-4 py-1.5">
                    <Share share={f.mine.share} n={f.mine.n} total={f.mine.n} />
                  </td>
                  <td className="px-4 py-1.5">
                    <Share share={f.niche.share} n={f.niche.n} total={f.niche.n} />
                  </td>
                  <td className="px-4 py-1.5">
                    <Delta value={f.shareDelta} />
                  </td>
                </tr>
              ))}
            </Table>
          </Panel>

          <Panel>
            <PanelHeader
              title="Caption traits"
              aside={<span className="text-[11px] text-ink-faint">niche = top quartile only</span>}
            />
            <Table head={['trait', 'me', 'niche', 'delta']}>
              {traits.map((t) => (
                <tr key={t.trait}>
                  <td className="px-4 py-1.5">{t.label}</td>
                  <td className="px-4 py-1.5">
                    <Share share={t.mine.share} n={t.mine.n} total={t.mine.total} />
                  </td>
                  <td className="px-4 py-1.5">
                    <Share share={t.niche.share} n={t.niche.n} total={t.niche.total} />
                  </td>
                  <td className="px-4 py-1.5">
                    <Delta value={t.delta} />
                  </td>
                </tr>
              ))}
            </Table>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
