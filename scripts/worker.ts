import '../lib/bootstrap-env';
import cron from 'node-cron';
import { closeDb } from '../lib/db/client';
import { JobRunner } from '../lib/jobs/runner';
import { enqueue, reapStaleClaims } from '../lib/jobs/queue';
import { getHandler } from '../lib/jobs/registry';

/**
 * The worker process. Separate from Next so a four-minute local generation
 * never blocks a page render.
 *
 * Polling every few seconds is fine here: the queue is a single SQLite table on
 * the same machine, and the alternative (a socket between two dev processes) is
 * more moving parts than this build needs.
 */

const runner = new JobRunner();
let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const n = await runner.drain();
    if (n > 0) console.log(`[worker] processed ${n} job(s)`);
  } catch (error) {
    console.error('[worker] tick failed', error);
  } finally {
    ticking = false;
  }
}

const reaped = reapStaleClaims();
if (reaped > 0) console.log(`[worker] released ${reaped} stale claim(s) from a previous run`);

if (process.argv.includes('--selftest')) {
  const id = enqueue('noop', { steps: 3, sleepMs: 10 });
  console.log(`[worker] selftest enqueued job ${id}`);
  await tick();
  console.log('[worker] selftest done');
  closeDb();
  process.exit(0);
}

console.log('[worker] started — polling every 5s');
const poll = setInterval(() => void tick(), 5_000);

// Scheduled maintenance. Handlers land in later milestones; the schedule lives
// here now so one place owns cadence. Enqueuing is skipped until the handler
// exists, so an unimplemented milestone doesn't fill the queue with failures.
const crons = [
  // Publishing / notification sweep, every minute (M10, M11).
  cron.schedule('* * * * *', () => {
    if (getHandler('publish_due')) enqueue('publish_due', {}, { dedupe: true });
  }),
  // Token refresh check, daily at 04:00 (M11).
  cron.schedule('0 4 * * *', () => {
    if (getHandler('refresh_ig_token')) enqueue('refresh_ig_token', {}, { dedupe: true });
  }),
];

void tick();

function shutdown(signal: string): void {
  console.log(`\n[worker] ${signal} — checkpointing and stopping`);
  clearInterval(poll);
  for (const c of crons) void c.stop();
  runner.stop();
  setTimeout(() => {
    closeDb();
    process.exit(0);
  }, 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
