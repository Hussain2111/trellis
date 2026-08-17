import '../lib/bootstrap-env';
import { closeDb } from '../lib/db/client';
import { upsertAccount } from '../lib/ingest/upsert';
import { enqueue } from '../lib/jobs/queue';
import { JobRunner } from '../lib/jobs/runner';
import { setSettings } from '../lib/settings';

/**
 * `npm run seed:demo`
 *
 * Populates the database with synthetic accounts and runs the whole pipeline
 * offline: no network, no credits, no API keys. It exists so the analysis
 * layers can be exercised end to end before your own data is in — and so a
 * regression in the pipeline shows up here rather than after a live scrape.
 *
 * Force fakes regardless of .env.local, so this never spends anything.
 */
process.env.SCRAPE_MODE = 'fake';
process.env.LLM_TIER_A = 'fake';
process.env.LLM_TIER_B = 'fake';
process.env.ENABLE_TRANSCRIPTION = 'true';

const HANDLES = {
  self: 'demo_self',
  competitors: ['niche_one', 'niche_two', 'niche_three', 'niche_four', 'niche_five', 'niche_six'],
};

async function main(): Promise<void> {
  setSettings({
    handle: HANDLES.self,
    niche: 'Landscape photography tutorials for beginners',
    analysisWindowDays: 30,
  });

  const self = upsertAccount({ handle: HANDLES.self, role: 'self' });
  const competitors = HANDLES.competitors.map((handle) =>
    upsertAccount({ handle, role: 'competitor' }),
  );

  console.log(`seeded 1 self + ${competitors.length} competitors`);

  const runner = new JobRunner();

  enqueue('scan_account', { accountId: self.id, limit: 140, incremental: false });
  for (const competitor of competitors) {
    enqueue('scan_account', { accountId: competitor.id, limit: 160, incremental: false });
  }
  console.log('scanning…');
  await runner.drain();

  const steps: [string, () => void][] = [
    ['features', () => void enqueue('compute_features', {})],
    ['transcription', () => void enqueue('transcribe_reels', { cap: 20 })],
    ['embeddings', () => void enqueue('embed_posts', {})],
    ['clustering', () => void enqueue('cluster_posts', { kMin: 8, kMax: 14 })],
    ['gap analysis', () => void enqueue('run_analysis', { windowDays: 30 })],
    ['voice profile', () => void enqueue('build_voice_profile', { topN: 20 })],
  ];

  for (const [label, enqueueStep] of steps) {
    console.log(`${label}…`);
    enqueueStep();
    await runner.drain();
  }

  const { latestAnalysis } = await import('../lib/jobs/handlers/analysis');
  const analysis = latestAnalysis();
  if (analysis) {
    console.log('drafts…');
    enqueue('generate_drafts', { analysisId: analysis.id, count: 6 });
    await runner.drain();
  }

  // Report what actually landed, so a silent failure is visible.
  const { db } = await import('../lib/db/client');
  const schema = await import('../lib/db/schema');
  const { sql } = await import('drizzle-orm');

  const tally = (name: string, table: never): void => {
    const row = db()
      .select({ n: sql<number>`count(*)` })
      .from(table)
      .get() as { n: number } | undefined;
    console.log(`  ${name.padEnd(16)} ${row?.n ?? 0}`);
  };

  console.log('\nresult:');
  tally('posts', schema.posts as never);
  tally('features', schema.postFeatures as never);
  tally('embeddings', schema.postEmbeddings as never);
  tally('archetypes', schema.archetypes as never);
  tally('labels', schema.postLabels as never);
  tally('analyses', schema.analyses as never);
  tally('drafts', schema.drafts as never);

  // A job left pending with an error is mid-backoff, which in a seed run means
  // it failed — surface it rather than letting the tally silently read zero.
  const broken = db()
    .select()
    .from(schema.jobs)
    .all()
    .filter((j) => j.status === 'failed' || (j.status === 'pending' && j.lastError));
  if (broken.length > 0) {
    console.log('\nbroken jobs:');
    for (const job of broken) console.log(`  ${job.type} [${job.status}]: ${job.lastError}`);
    process.exitCode = 1;
  }

  closeDb();
}

await main();
