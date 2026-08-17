import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { accounts, jobs, posts } from '@/lib/db/schema';
import { Badge, Empty, Panel, PanelHeader, Stat } from '@/components/ui/primitives';

export const dynamic = 'force-dynamic';

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const accountRows = await db().execute<{ n: number }>(
    sql`select count(*)::int as n from ${accounts}`,
  );
  const postRows = await db().execute<{ n: number }>(sql`select count(*)::int as n from ${posts}`);
  const accountCount = accountRows[0]?.n ?? 0;
  const postCount = postRows[0]?.n ?? 0;
  const recentJobs = await db()
    .select()
    .from(jobs)
    .orderBy(sql`${jobs.id} desc`)
    .limit(6);

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[20px] leading-tight font-semibold">No account configured yet</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            Stage 1 foundation — schema, jobs infra, and the keepalive cron are live. The scan
            pipeline, analysis, drafts, and chat land in the stages that follow.
          </p>
        </div>
        <Badge tone="signal">stage 1 / 8</Badge>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Database" />
          <div className="grid grid-cols-2 divide-x divide-line">
            <Stat label="Accounts" value={accountCount} />
            <Stat label="Posts" value={postCount} />
          </div>
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
                          : job.status === 'running' || job.status === 'claimed'
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
