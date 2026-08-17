import Link from 'next/link';
import { desc } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { jobs } from '@/lib/db/schema';
import { activeJobs } from '@/lib/jobs/queue';
import { allBudgets } from '@/lib/quota/budget';
import { monthlyCostSummary } from '@/lib/runs/log';
import { providerStatuses } from '@/lib/providers';
import { getSettings } from '@/lib/settings';
import { Badge, Button, Empty, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { formatRelative, formatUsd } from '@/lib/utils';
import { enqueueSelftestAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const settings = getSettings();
  const providers = await providerStatuses();
  const cost = monthlyCostSummary();
  const budgets = allBudgets();
  const running = activeJobs();
  const recent = db().select().from(jobs).orderBy(desc(jobs.id)).limit(8).all();

  const setup = [
    { label: 'Database migrated', done: true, hint: 'data/app.db' },
    { label: 'Handle set', done: settings.handle.length > 0, hint: 'Settings → account' },
    { label: 'Niche described', done: settings.niche.length > 0, hint: 'Settings → account' },
    {
      label: 'Local model chosen',
      done: settings.ollamaModel.length > 0 || (process.env.OLLAMA_MODEL ?? '').length > 0,
      hint: 'npm run bench:llm',
    },
    {
      label: 'Tier A key present',
      done: (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '').length > 0,
      hint: 'aistudio.google.com/apikey',
    },
    {
      label: 'Apify token present',
      done: (process.env.APIFY_TOKEN ?? '').length > 0,
      hint: 'needed from M1',
    },
  ];
  const remaining = setup.filter((s) => !s.done).length;

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[20px] leading-tight font-semibold">
            {settings.handle ? `@${settings.handle}` : 'No account configured yet'}
          </h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            {settings.niche || 'Tell me your niche in Settings and I can start benchmarking it.'}
          </p>
        </div>
        <Badge tone={cost.monthToDateUsd === 0 ? 'good' : 'bad'}>
          {formatUsd(cost.monthToDateUsd)} this month
        </Badge>
      </header>

      {/* The headline slot. From M5 this carries the gap as a sentence with
          numbers in it; until then it says so plainly rather than faking one. */}
      <Panel className="mb-4 border-signal/25 bg-signal/[0.04]">
        <div className="px-5 py-5">
          <div className="label text-signal/70">Biggest gap</div>
          <p className="mt-2 text-[16px] leading-relaxed text-ink-muted">
            Nothing analysed yet. I need your posts and a competitor list before I can tell you
            what you&apos;re missing — that starts at{' '}
            <span className="metric text-signal">M1</span>, and the first real gap lands at{' '}
            <span className="metric text-signal">M5</span>.
          </p>
        </div>
      </Panel>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Setup"
            aside={
              <Badge tone={remaining === 0 ? 'good' : 'signal'}>
                {remaining === 0 ? 'complete' : `${remaining} left`}
              </Badge>
            }
          />
          <ul className="divide-y divide-line">
            {setup.map((item) => (
              <li key={item.label} className="flex items-center gap-3 px-4 py-2">
                <span
                  className={`metric text-[13px] ${item.done ? 'text-positive' : 'text-ink-faint'}`}
                >
                  {item.done ? '✓' : '·'}
                </span>
                <span className="flex-1 text-[13px]">{item.label}</span>
                <span className="font-mono text-[11px] text-ink-faint">{item.hint}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel>
          <PanelHeader title="Providers" aside={<Badge tone="good">all free tier</Badge>} />
          <ul className="divide-y divide-line">
            {providers.map((p) => (
              <li key={`${p.kind}-${p.id}`} className="flex items-start gap-3 px-4 py-2">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${p.ok ? 'bg-positive' : 'bg-negative'}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px]">{p.id}</span>
                    {p.model ? (
                      <span className="font-mono text-[11px] text-ink-faint">{p.model}</span>
                    ) : null}
                    {p.costsMoney ? <Badge tone="bad">billable</Badge> : null}
                  </div>
                  <p className="truncate text-[12px] text-ink-faint">{p.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel>
          <PanelHeader
            title="Background jobs"
            aside={
              <form action={enqueueSelftestAction}>
                <Button size="sm" variant="ghost" type="submit">
                  run self-test
                </Button>
              </form>
            }
          />
          {recent.length === 0 ? (
            <Empty
              title="Queue is empty."
              detail="Long operations run here so the UI never blocks on a model call. Run the self-test to watch one move."
            />
          ) : (
            <ul className="divide-y divide-line">
              {recent.map((job) => (
                <li key={job.id} className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <span className="metric text-[11px] text-ink-faint">#{job.id}</span>
                    <span className="font-mono text-[12px]">{job.type}</span>
                    <Badge
                      tone={
                        job.status === 'done'
                          ? 'good'
                          : job.status === 'failed'
                            ? 'bad'
                            : job.status === 'running' || job.status === 'claimed'
                              ? 'signal'
                              : 'neutral'
                      }
                    >
                      {job.status}
                    </Badge>
                    <span className="ml-auto text-[11px] text-ink-faint">
                      {formatRelative(job.createdAt)}
                    </span>
                  </div>
                  {job.status === 'running' || job.status === 'claimed' ? (
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full bg-signal"
                          style={{ width: `${Math.round(job.progress * 100)}%` }}
                        />
                      </div>
                      <span className="metric text-[11px] text-ink-faint">
                        {job.progressLabel ?? `${Math.round(job.progress * 100)}%`}
                      </span>
                    </div>
                  ) : null}
                  {job.lastError ? (
                    <p className="mt-1 truncate text-[11px] text-negative">{job.lastError}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {running.length > 0 ? (
            <div className="border-t border-line px-4 py-2 text-[11px] text-ink-faint">
              {running.length} job(s) queued or running. The worker polls every 5s — make sure
              <span className="metric"> npm run dev </span>is running both processes.
            </div>
          ) : null}
        </Panel>

        <Panel>
          <PanelHeader title="Free-tier headroom" />
          {budgets.length === 0 ? (
            <Empty
              title="No quota spent yet."
              detail="Allowances appear the first time a job type asks for Tier A. Chat yields first when the day runs short."
            />
          ) : (
            <ul className="divide-y divide-line">
              {budgets.map((b) => (
                <li key={b.id} className="flex items-center gap-3 px-4 py-2">
                  <span className="font-mono text-[12px]">{b.jobType}</span>
                  <span className="ml-auto metric text-[12px] text-ink-muted">
                    {b.consumedToday}/{b.dailyAllowance}
                  </span>
                  {b.exhaustedUntil && b.exhaustedUntil > Math.floor(Date.now() / 1000) ? (
                    <Badge tone="bad">exhausted</Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-2 divide-x divide-line border-t border-line">
            <Stat
              label="External calls (mo)"
              value={<span className="tabular">{cost.callCount}</span>}
            />
            <Stat
              label="Spend (mo)"
              value={formatUsd(cost.monthToDateUsd)}
              tone={cost.monthToDateUsd === 0 ? 'good' : 'bad'}
              sub={cost.paidCallCount > 0 ? `${cost.paidCallCount} billable calls` : 'all free tier'}
            />
          </div>
        </Panel>
      </div>

      <p className="mt-6 text-[12px] text-ink-faint">
        M0 is scaffolding: database, job queue, provider interfaces, the paid-provider guard, and
        the benchmark. Run <span className="metric text-ink-muted">npm run bench:llm</span> next —
        it decides the local model.{' '}
        <Link href="/settings" className="text-info hover:underline">
          Settings
        </Link>
      </p>
    </div>
  );
}
