import { desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { runs } from '@/lib/db/schema';
import { env } from '@/lib/env';
import { monthlyCostSummary, recentRuns } from '@/lib/runs/log';
import { Badge, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { Table } from '@/components/ui/data';
import { formatUsd } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function SettingsPage(): Promise<React.JSX.Element> {
  const e = env();
  const cost = await monthlyCostSummary();
  const runList = await recentRuns(30);
  const [tokenCheck] = await db()
    .select()
    .from(runs)
    .where(eq(runs.operation, 'token_check'))
    .orderBy(desc(runs.id))
    .limit(1);

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5">
        <h1 className="text-[20px] leading-tight font-semibold">Settings</h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          Provider configuration and the $0.00 cost check.
        </p>
      </header>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Cost this month"
            aside={
              <Badge tone={cost.paidCallCount === 0 ? 'good' : 'bad'}>
                {cost.paidCallCount === 0 ? '$0/month' : 'paid calls detected'}
              </Badge>
            }
          />
          <div className="grid grid-cols-3 divide-x divide-line">
            <Stat label="Total" value={formatUsd(cost.monthToDateUsd)} />
            <Stat label="Calls" value={cost.callCount} />
            <Stat
              label="Paid calls"
              value={cost.paidCallCount}
              tone={cost.paidCallCount === 0 ? 'good' : 'bad'}
            />
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Guards" />
          <div className="grid grid-cols-2 gap-y-2 px-4 py-3 text-[12px]">
            <span className="label">ALLOW_PAID_PROVIDERS</span>
            <Badge tone={e.ALLOW_PAID_PROVIDERS ? 'bad' : 'good'}>
              {String(e.ALLOW_PAID_PROVIDERS)}
            </Badge>
            <span className="label">ENABLE_IG_PUBLISHING</span>
            <Badge tone={e.ENABLE_IG_PUBLISHING ? 'signal' : 'neutral'}>
              {String(e.ENABLE_IG_PUBLISHING)}
            </Badge>
            <span className="label">SCRAPE_MODE</span>
            <Badge tone={e.SCRAPE_MODE === 'live' ? 'signal' : 'neutral'}>{e.SCRAPE_MODE}</Badge>
            <span className="label">IMAGE_PROVIDER</span>
            <Badge tone="neutral">{e.IMAGE_PROVIDER}</Badge>
          </div>
        </Panel>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Providers" />
          <div className="grid grid-cols-2 gap-y-2 px-4 py-3 text-[12px]">
            <span className="label">LLM</span>
            <span className="font-mono">
              {e.LLM_PROVIDER}:{e.GOOGLE_MODEL}
            </span>
            <span className="label">Scraper</span>
            <span className="font-mono">apify ({e.APIFY_ACTOR})</span>
            <span className="label">Images</span>
            <span className="font-mono">{e.IMAGE_PROVIDER}</span>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Instagram publishing" />
          <div className="px-4 py-3 text-[12px]">
            {!e.ENABLE_IG_PUBLISHING ? (
              <p className="text-ink-muted">
                Disabled. Scheduled drafts wait for you to post them by hand — see{' '}
                <span className="font-mono">docs/instagram-setup.md</span>.
              </p>
            ) : tokenCheck ? (
              <div className="flex items-center gap-2">
                <Badge tone={tokenCheck.status === 'ok' ? 'good' : 'bad'}>
                  {tokenCheck.status}
                </Badge>
                <span className="text-ink-muted">
                  {tokenCheck.error ?? `checked ${new Date(tokenCheck.createdAt).toLocaleString()}`}
                </span>
              </div>
            ) : (
              <p className="text-ink-faint">No token check has run yet.</p>
            )}
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Recent provider calls" />
        {runList.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px] text-ink-muted">
            No calls logged yet.
          </div>
        ) : (
          <Table head={['When', 'Provider', 'Operation', 'Status', 'Cost']}>
            {runList.map((run) => (
              <tr key={run.id}>
                <td className="px-4 py-2 whitespace-nowrap text-ink-muted">
                  {new Date(run.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-2 font-mono">{run.provider}</td>
                <td className="px-4 py-2">{run.operation}</td>
                <td className="px-4 py-2">
                  <Badge
                    tone={
                      run.status === 'ok'
                        ? 'good'
                        : run.status === 'error'
                          ? 'bad'
                          : run.status === 'quota'
                            ? 'signal'
                            : 'neutral'
                    }
                  >
                    {run.status}
                  </Badge>
                </td>
                <td className="metric px-4 py-2">{formatUsd(run.costEstimate ?? 0)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
