import { desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { runs } from '@/lib/db/schema';
import { env } from '@/lib/env';
import { monthlyCostSummary, recentRuns } from '@/lib/runs/log';
import { getApifySpend, getBudgetSkips } from '@/lib/ingest/budget';
import { inspectToken } from '@/lib/publish/graph';
import { Badge, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { Table } from '@/components/ui/data';
import { formatRiyadh } from '@/lib/time';
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
  const spend = await getApifySpend(e.APIFY_MONTHLY_CREDIT_USD);
  const skips = await getBudgetSkips(5);
  // Checked live rather than read from the last cron run: a missing scope is
  // the difference between "this account is quiet" and "this app cannot see
  // the numbers", and that distinction should not be up to 24 hours stale.
  const token = e.IG_ACCESS_TOKEN ? await inspectToken(e.IG_ACCESS_TOKEN) : null;

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
          </div>
        </Panel>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Apify credit this month"
            aside={
              <Badge tone={spend.remainingUsd > 0 ? 'neutral' : 'bad'}>
                {spend.observed ? 'observed rate' : 'estimated rate'}
              </Badge>
            }
          />
          <div className="grid grid-cols-3 divide-x divide-line">
            <Stat label="Spent" value={formatUsd(spend.spentUsd)} />
            <Stat
              label="Left"
              value={formatUsd(spend.remainingUsd)}
              tone={spend.remainingUsd > 0 ? undefined : 'bad'}
            />
            <Stat label="Items" value={spend.itemsScraped} />
          </div>
          {skips.length > 0 ? (
            <div className="border-t border-line px-4 py-3">
              <div className="label mb-1.5">Recently skipped for budget</div>
              <ul className="space-y-1">
                {skips.map((skip, i) => (
                  <li key={i} className="text-[11px] text-ink-faint">
                    <span className="font-mono text-ink-muted">{skip.operation}</span> ·{' '}
                    {formatRiyadh(skip.at)} · {skip.note}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Panel>

        <Panel>
          <PanelHeader
            title="Instagram Graph API"
            aside={
              token ? (
                <Badge
                  tone={!token.valid ? 'bad' : token.missingScopes.length > 0 ? 'bad' : 'good'}
                >
                  {!token.valid
                    ? 'invalid'
                    : token.missingScopes.length > 0
                      ? 'missing scopes'
                      : 'ok'}
                </Badge>
              ) : (
                <Badge tone="bad">not configured</Badge>
              )
            }
          />
          <div className="px-4 py-3 text-[12px]">
            {!token ? (
              <p className="text-ink-muted">
                IG_ACCESS_TOKEN is not set. The managed account&rsquo;s own posts, insights and
                comments all come from the Graph API — without it those tabs stay empty. See{' '}
                <span className="font-mono">docs/instagram-setup.md</span>.
              </p>
            ) : (
              <div className="space-y-1.5">
                <p className="text-ink-muted">{token.detail}</p>
                {token.missingScopes.length > 0 ? (
                  <p className="text-negative">
                    Regenerate the token with{' '}
                    <span className="font-mono">{token.missingScopes.join(', ')}</span>. Without
                    them these endpoints return nothing rather than erroring, so the numbers would
                    read as a quiet account.
                  </p>
                ) : null}
              </div>
            )}
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
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Auto-publishing" />
          <div className="px-4 py-3 text-[12px]">
            {!e.ENABLE_IG_PUBLISHING ? (
              <p className="text-ink-muted">
                Disabled. Calendar entries wait for you to post them by hand — see{' '}
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
