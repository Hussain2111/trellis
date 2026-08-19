/**
 * Confirms every scheduled endpoint refuses an unauthenticated caller.
 *
 * `/api/pipeline/tick` and `/api/calendar/tick` were publicly triggerable
 * before v2 — anyone who knew the URL could spin the job queue. They were
 * removed rather than gated, so this also asserts they are gone: a 404 is the
 * pass condition for those two, and a 200 would mean an old deployment is
 * still serving them.
 *
 *   npx tsx scripts/verify-cron-auth.ts https://your-app.vercel.app
 *   CRON_SECRET=... npx tsx scripts/verify-cron-auth.ts <url>   # also check the secret works
 *
 * Read-only against production in the sense that matters: every request it
 * expects to succeed is one the scheduler makes anyway. Without CRON_SECRET
 * set it only sends requests that should be rejected, and touches nothing.
 */

const GUARDED = [
  '/api/cron/keepalive',
  '/api/cron/publish',
  '/api/cron/daily-own-account',
  '/api/cron/weekly-niche',
  '/api/cron/token-refresh',
  '/api/jobs/tick',
];

/** Removed in v2. Anything other than 404/405 means a stale deployment. */
const SHOULD_NOT_EXIST = ['/api/pipeline/tick', '/api/calendar/tick'];

interface Result {
  label: string;
  pass: boolean;
  detail: string;
}

const results: Result[] = [];

async function probe(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, { ...init, redirect: 'manual' });
    return { status: res.status, body: (await res.text()).slice(0, 120) };
  } catch (error) {
    return { status: 0, body: (error as Error).message };
  }
}

async function main(): Promise<void> {
  const base = (process.argv[2] ?? '').replace(/\/$/, '');
  if (!base) {
    console.error('Usage: verify-cron-auth <base-url>');
    process.exit(1);
  }
  const secret = process.env.CRON_SECRET;

  console.log(`Checking ${base}\n`);

  for (const path of GUARDED) {
    const method = path === '/api/jobs/tick' ? 'POST' : 'GET';

    const bare = await probe(`${base}${path}`, { method });
    results.push({
      label: `${path} without a token`,
      pass: bare.status === 401,
      detail: `${method} → ${bare.status}${bare.status === 401 ? '' : ` (want 401) ${bare.body}`}`,
    });

    const wrong = await probe(`${base}${path}`, {
      method,
      headers: { authorization: 'Bearer definitely-not-the-secret' },
    });
    results.push({
      label: `${path} with a wrong token`,
      pass: wrong.status === 401,
      detail: `${method} → ${wrong.status}${wrong.status === 401 ? '' : ` (want 401) ${wrong.body}`}`,
    });

    if (secret) {
      const good = await probe(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${secret}` },
      });
      results.push({
        label: `${path} with the real secret`,
        pass: good.status === 200,
        detail: `${method} → ${good.status}${good.status === 200 ? '' : ` (want 200) ${good.body}`}`,
      });
    }
  }

  for (const path of SHOULD_NOT_EXIST) {
    const res = await probe(`${base}${path}`, { method: 'POST' });
    const gone = res.status === 404 || res.status === 405;
    results.push({
      label: `${path} is gone`,
      pass: gone,
      detail: `POST → ${res.status}${gone ? '' : ' — a stale deployment is still serving this publicly'}`,
    });
  }

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.label.padEnd(50)} ${r.detail}`);
  }

  console.log(`\n${results.length - failed}/${results.length} passed.`);
  if (!secret) {
    console.log(
      'CRON_SECRET was not set, so the positive path (real secret → 200) was not checked. ' +
        'Set it to the same value as Vercel and GitHub to confirm all three agree.',
    );
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
