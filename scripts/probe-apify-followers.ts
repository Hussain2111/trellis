import fs from 'node:fs';
import { ApifyClient } from 'apify-client';
import '../lib/bootstrap-env';

/**
 * First contact with the follower-list actor, and — the actual point — the
 * real per-1000 cost of one.
 *
 * `resultsType: 'followers'` is an untested assumption of exactly the kind
 * that broke v1 in production (`usernames` vs `username`). This runs the actor
 * once with a tiny limit, prints the input it accepted and the record shape it
 * returned, and reports what Apify actually charged.
 *
 *   npx tsx scripts/probe-apify-followers.ts <handle> [limit]
 *
 * Defaults to a limit of 20. It DOES spend credit — a few cents at most at
 * that limit, which is the price of not guessing. It writes nothing to the
 * database.
 */

const token = process.env.APIFY_TOKEN ?? '';
const actor = process.env.APIFY_FOLLOWERS_ACTOR ?? 'apify/instagram-profile-scraper';

async function main(): Promise<void> {
  const handle = (process.argv[2] ?? '').replace(/^@/, '').trim();
  const limit = Number(process.argv[3] ?? 20);

  if (!token || !handle) {
    console.error('Usage: probe-apify-followers <handle> [limit]   (needs APIFY_TOKEN)');
    process.exit(1);
  }
  if (limit > 100) {
    console.error(`Refusing a limit of ${limit}. This probe exists to be cheap; use 20–50.`);
    process.exit(1);
  }

  const client = new ApifyClient({ token });

  console.log(`Actor:  ${actor}`);
  console.log(`Handle: @${handle}`);
  console.log(`Limit:  ${limit}\n`);

  // Print the actor's declared input schema first. If the run fails, this is
  // the thing that says why — and it costs nothing to fetch.
  try {
    const build = await client.actor(actor).defaultBuild();
    const info = await build.get();
    const schema = (info as { actorDefinition?: { input?: unknown } })?.actorDefinition?.input;
    console.log('--- declared input schema -------------------------------------');
    console.log(JSON.stringify(schema, null, 2).slice(0, 4000));
  } catch (error) {
    console.log(`(could not read the actor's input schema: ${(error as Error).message})`);
  }

  const input = { usernames: [handle], resultsType: 'followers', resultsLimit: limit };
  console.log('\n--- input sent ------------------------------------------------');
  console.log(JSON.stringify(input, null, 2));

  const startedAt = Date.now();
  const run = await client.actor(actor).call(input, { waitSecs: 300 });

  console.log('\n--- run -------------------------------------------------------');
  console.log(`status         ${run.status}`);
  console.log(`runId          ${run.id}`);
  console.log(`wall clock     ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`items returned ${items.length}`);

  console.log('\n--- first 3 records, raw --------------------------------------');
  console.log(JSON.stringify(items.slice(0, 3), null, 2).slice(0, 4000));

  if (items.length > 0) {
    const keys = new Set<string>();
    for (const item of items) for (const k of Object.keys(item as object)) keys.add(k);
    console.log('\n--- keys present across all records ---------------------------');
    console.log([...keys].sort().join(', '));

    // `normalizeFollowerItems` looks for these three, in this order.
    const expected = ['username', 'ownerUsername', 'handle'];
    const matched = expected.filter((k) => keys.has(k));
    console.log(
      matched.length > 0
        ? `\nOK: normalizeFollowerItems will read "${matched[0]}".`
        : `\nMISMATCH: normalizeFollowerItems looks for ${expected.join('/')} and none are present. ` +
            `Add the real key to lib/jobs/handlers/snapshot-followers.ts AND to the fixture in tests/followers.test.ts.`,
    );
  }

  // --- the number that decides whether named unfollows is affordable -------
  const usage = (run as { usageTotalUsd?: number }).usageTotalUsd;
  console.log('\n--- cost ------------------------------------------------------');
  if (typeof usage === 'number' && items.length > 0) {
    const perItem = usage / items.length;
    console.log(`this run          $${usage.toFixed(5)} for ${items.length} item(s)`);
    console.log(`per 1,000 items   $${(perItem * 1000).toFixed(3)}`);
    console.log('');
    for (const size of [4900, 10_000]) {
      console.log(
        `projected ${String(size).padStart(6)} followers: $${(perItem * size).toFixed(2)}`,
      );
    }
    console.log('');
    const full = perItem * 4900;
    const monthly = Number(process.env.APIFY_MONTHLY_CREDIT_USD ?? 5);
    console.log(
      full > monthly
        ? `VERDICT: one full snapshot ($${full.toFixed(2)}) exceeds the whole monthly allowance ` +
            `($${monthly.toFixed(2)}). Named unfollows is not affordable on free credit — and a diff ` +
            `needs TWO snapshots, so the real cost of one comparison is $${(full * 2).toFixed(2)}.`
        : `VERDICT: one full snapshot is $${full.toFixed(2)} of a $${monthly.toFixed(2)} allowance. ` +
            `A diff needs two, so one comparison costs $${(full * 2).toFixed(2)} — ` +
            `${((full * 2 * 100) / monthly).toFixed(0)}% of the month.`,
    );
    console.log(
      `\nAlso update DEFAULT_USD_PER_1000_ITEMS in lib/ingest/budget.ts if $${(perItem * 1000).toFixed(3)} ` +
        `differs much from the 2.3 assumed there.`,
    );
  } else {
    console.log(
      `usageTotalUsd was ${JSON.stringify(usage)} — read the real figure from the run in the Apify console:`,
    );
    console.log(`  https://console.apify.com/actors/runs/${run.id}`);
  }

  const out = 'apify-followers-probe.json';
  fs.writeFileSync(
    out,
    JSON.stringify({ actor, input, status: run.status, usageTotalUsd: usage, items }, null, 2),
  );
  console.log(`\nRaw output written to ${out}. Contains real usernames — do not commit it.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
