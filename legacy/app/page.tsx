import Link from 'next/link';
import { desc, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { drafts, jobs, posts } from '@/lib/db/schema';
import { activeJobs } from '@/lib/jobs/queue';
import { allBudgets } from '@/lib/quota/budget';
import { monthlyCostSummary } from '@/lib/runs/log';
import { budgetState } from '@/lib/ingest/budget';
import { loadCorpus, poolComposition } from '@/lib/analysis/benchmark';
import { detectDecay } from '@/lib/analysis/aggregate';
import { activeArchetypes } from '@/lib/analysis/archetypes';
import { latestAnalysis } from '@/lib/jobs/handlers/analysis';
import { dueNow, scheduledRows } from '@/lib/jobs/handlers/publish';
import { activeVoice } from '@/lib/analysis/voice';
import { listAccounts, selfAccount } from '@/lib/ingest/upsert';
import { env } from '@/lib/env';
import { getSettings } from '@/lib/settings';
import { Badge, Empty, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { GeneratedBy, PoolWarning } from '@/components/ui/data';
import { ActionButton } from '@/components/action-button';
import { generateDraftsAction, runJobAction } from './actions';
import { formatNumber, formatRelative, formatUsd } from '@/lib/utils';
import type { Gap } from '@/lib/prompts/gap-analysis.v1';

export const dynamic = 'force-dynamic';

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const settings = getSettings();
  const self = selfAccount();
  const accounts = listAccounts();
  const analysis = latestAnalysis();
  const gap = analysis ? (analysis.gap as Gap & { repaired?: boolean }) : null;
  const cost = monthlyCostSummary();
  const budgets = allBudgets();
  const apify = budgetState(env().APIFY_MONTHLY_CREDIT_USD);
  const running = activeJobs();
  const recent = db().select().from(jobs).orderBy(desc(jobs.id)).limit(6).all();
  const corpus = loadCorpus();
  const pool = poolComposition(corpus);
  const archetypes = activeArchetypes();
  const voice = activeVoice();
  const decayed = detectDecay(settings.analysisWindowDays, settings.outlierMultiplier);

  const postCount =
    db().select({ n: sql<number>`count(*)` }).from(posts).get()?.n ?? 0;
  const weekDrafts = db()
    .select()
    .from(drafts)
    .orderBy(desc(drafts.id))
    .all()
    .filter((d) => d.status === 'draft' || d.status === 'approved' || d.status === 'scheduled')
    .slice(0, 5);
  const upcoming = scheduledRows().filter((r) => r.schedule.status === 'pending');
  const due = dueNow();

  /** The pipeline, in order, with the first unfinished step highlighted. */
  const pipeline = [
    { label: 'Account added', done: !!self, action: null, href: '/competitors' },
    { label: 'Posts scanned', done: Number(postCount) > 0, action: null, href: '/posts' },
    { label: 'Competitors scanned', done: pool.totalPosts > 0, action: null, href: '/competitors' },
    { label: 'Embedded', done: archetypes.length > 0 || corpus.length === 0 ? archetypes.length > 0 : false, action: 'embed_posts', href: '/archetypes' },
    { label: 'Archetypes named', done: archetypes.length > 0, action: 'cluster_posts', href: '/archetypes' },
    { label: 'Gap analysed', done: !!analysis, action: 'run_analysis', href: '/gap' },
    { label: 'Voice profile', done: !!voice, action: 'build_voice_profile', href: '/voice' },
    { label: 'Drafts written', done: weekDrafts.length > 0, action: null, href: '/drafts' },
  ];
  const nextStep = pipeline.find((step) => !step.done);

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[20px] leading-tight font-semibold">
            {self ? `@${self.handle}` : 'No account configured yet'}
          </h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            {self
              ? `${formatNumber(self.followers)} followers · ${formatNumber(Number(postCount))} posts held · benchmarked against ${pool.accounts.length} accounts`
              : 'Add your handle in Competitors, then scan it.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={cost.monthToDateUsd === 0 ? 'good' : 'bad'}>
            {formatUsd(cost.monthToDateUsd)} this month
          </Badge>
        </div>
      </header>

      {/* The headline. A sentence with numbers in it — not a chart. */}
      <Panel className="mb-4 border-signal/25 bg-signal/[0.04]">
        <div className="px-5 py-5">
          <div className="flex items-center justify-between gap-3">
            <div className="label text-signal/70">Biggest gap</div>
            {analysis ? <GeneratedBy value={analysis.generatedBy} /> : null}
          </div>
          {gap ? (
            <>
              <p className="mt-2 text-[17px] leading-relaxed">{gap.claim}</p>
              <div className="mt-2.5 flex flex-wrap items-baseline gap-x-6 gap-y-1">
                <span className="metric text-[13px]">
                  <span className="label mr-1.5">niche</span>
                  {gap.niche_stat}
                </span>
                <span className="metric text-[13px]">
                  <span className="label mr-1.5">you</span>
                  {gap.my_stat}
                </span>
                <span className="metric text-[13px] text-signal">
                  <span className="label mr-1.5">delta</span>
                  {gap.delta}
                </span>
                <Link href="/gap" className="ml-auto text-[12px] text-info hover:underline">
                  see the receipts →
                </Link>
              </div>
            </>
          ) : (
            <p className="mt-2 text-[15px] leading-relaxed text-ink-muted">
              {nextStep
                ? `Nothing analysed yet — next step is "${nextStep.label.toLowerCase()}".`
                : 'Nothing analysed yet.'}
            </p>
          )}
        </div>
        <PoolWarning warning={pool.warning} />
      </Panel>

      {due.length > 0 ? (
        <Panel className="mb-4 border-positive/30 bg-positive/[0.04]">
          <div className="flex items-center gap-3 px-5 py-3">
            <span className="text-[13px]">
              <span className="metric text-positive">{due.length}</span> post
              {due.length === 1 ? '' : 's'} ready to go out now.
            </span>
            <Link href="/calendar" className="ml-auto text-[12px] text-info hover:underline">
              open the calendar →
            </Link>
          </div>
        </Panel>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Pipeline"
            aside={
              nextStep ? <Badge tone="signal">next: {nextStep.label}</Badge> : <Badge tone="good">complete</Badge>
            }
          />
          <ul className="divide-y divide-line">
            {pipeline.map((step) => (
              <li key={step.label} className="flex items-center gap-3 px-4 py-2">
                <span
                  className={`metric text-[13px] ${step.done ? 'text-positive' : step === nextStep ? 'text-signal' : 'text-ink-faint'}`}
                >
                  {step.done ? '✓' : step === nextStep ? '▸' : '·'}
                </span>
                <Link href={step.href} className="flex-1 text-[13px] hover:underline">
                  {step.label}
                </Link>
                {!step.done && step.action ? (
                  <ActionButton
                    action={runJobAction.bind(null, step.action!)}
                    label="run"
                    variant="ghost"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>

        <Panel>
          <PanelHeader
            title="This week's drafts"
            aside={
              analysis ? (
                <ActionButton
                  action={generateDraftsAction.bind(null, 12)}
                  label="write 12"
                  variant="ghost"
                />
              ) : null
            }
          />
          {weekDrafts.length === 0 ? (
            <Empty
              title="No drafts waiting."
              detail="Drafts are written against the current gap, in your voice, with the format mix the niche rewards."
            />
          ) : (
            <ul className="divide-y divide-line">
              {weekDrafts.map((draft) => (
                <li key={draft.id} className="px-4 py-2">
                  <Link href={`/drafts/${draft.id}`} className="block hover:underline">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-ink-faint">{draft.format}</span>
                      <span className="flex-1 truncate text-[13px]">{draft.title}</span>
                      <Badge tone={draft.status === 'scheduled' ? 'signal' : 'neutral'}>
                        {draft.status}
                      </Badge>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {upcoming.length > 0 ? (
            <div className="border-t border-line px-4 py-2 text-[11px] text-ink-faint">
              Next scheduled {formatRelative(upcoming[0]!.schedule.scheduledFor)} ·{' '}
              {upcoming.length} queued
            </div>
          ) : null}
        </Panel>

        <Panel>
          <PanelHeader
            title="Background jobs"
            aside={running.length > 0 ? <Badge tone="signal">{running.length} active</Badge> : null}
          />
          {recent.length === 0 ? (
            <Empty
              title="Queue is empty."
              detail="Long operations run here so the UI never blocks on a model call."
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
                          className="h-full bg-signal transition-all"
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
        </Panel>

        <Panel>
          <PanelHeader title="Headroom" />
          <div className="grid grid-cols-2 divide-x divide-line border-b border-line">
            <Stat
              label="Apify credits left"
              value={formatUsd(apify.remainingUsd)}
              tone={apify.remainingUsd > 1 ? 'good' : 'bad'}
              sub={`~${formatNumber(apify.estimatedItemsRemaining)} more posts`}
            />
            <Stat
              label="Spend (mo)"
              value={formatUsd(cost.monthToDateUsd)}
              tone={cost.monthToDateUsd === 0 ? 'good' : 'bad'}
              sub={cost.paidCallCount > 0 ? `${cost.paidCallCount} billable` : 'all free tier'}
            />
          </div>
          {budgets.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-ink-faint">
              Tier A allowances appear the first time a job type asks for one. Chat yields first
              when the day runs short.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {budgets.map((b) => (
                <li key={b.id} className="flex items-center gap-3 px-4 py-1.5">
                  <span className="font-mono text-[12px]">{b.jobType}</span>
                  <span className="metric ml-auto text-[12px] text-ink-muted">
                    {b.consumedToday}/{b.dailyAllowance}
                  </span>
                  {b.exhaustedUntil && b.exhaustedUntil > Math.floor(Date.now() / 1000) ? (
                    <Badge tone="bad">exhausted</Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {decayed.length > 0 ? (
          <Panel className="lg:col-span-2">
            <PanelHeader
              title="Back catalogue"
              aside={<Badge tone="signal">no model involved</Badge>}
            />
            <ul className="divide-y divide-line">
              {decayed.slice(0, 3).map((row) => (
                <li key={row.archetypeId} className="px-4 py-2.5 text-[13px]">
                  Your <span className="text-ink">{row.name}</span> posts hit a median of{' '}
                  <span className="metric text-signal">
                    {formatNumber(row.medianLikesWhenUsed)}
                  </span>{' '}
                  likes. In the last {settings.analysisWindowDays} days you made{' '}
                  <span className="metric text-negative">zero</span> like it.
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </div>

      {accounts.length === 0 ? (
        <p className="mt-6 text-[12px] text-ink-faint">
          Nothing is set up yet. Start in{' '}
          <Link href="/competitors" className="text-info hover:underline">
            Competitors
          </Link>{' '}
          by adding your own handle, then five to fifteen accounts you consider your niche.
        </p>
      ) : null}
    </div>
  );
}
