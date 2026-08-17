import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { jobs, posts } from '@/lib/db/schema';
import { selfAccount } from '@/lib/ingest/upsert';
import { Badge, Empty, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { ScanForm } from '@/components/scan-form';
import { PipelineTickPoller } from '@/components/pipeline-tick-poller';
import { formatNumber } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const self = await selfAccount();
  const postRows = self
    ? await db().execute<{ n: number }>(
        sql`select count(*)::int as n from ${posts} where account_id = ${self.id}`,
      )
    : [{ n: 0 }];
  const postCount = postRows[0]?.n ?? 0;
  const recentJobs = await db()
    .select()
    .from(jobs)
    .orderBy(sql`${jobs.id} desc`)
    .limit(6);

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <PipelineTickPoller />
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[20px] leading-tight font-semibold">
            {self ? `@${self.handle}` : 'No account configured yet'}
          </h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            {self
              ? `${formatNumber(self.followers)} followers · ${formatNumber(postCount)} posts held`
              : 'Enter your Instagram handle to scan your last 100 posts.'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ScanForm />
        </div>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Account" />
          {self ? (
            <div className="grid grid-cols-2 divide-x divide-line">
              <Stat label="Posts held" value={formatNumber(postCount)} />
              <Stat label="Followers" value={formatNumber(self.followers)} />
            </div>
          ) : (
            <Empty
              title="Nothing scanned yet."
              detail="One field, no password, no OAuth — enter a handle above to start."
            />
          )}
        </Panel>

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
    </div>
  );
}
