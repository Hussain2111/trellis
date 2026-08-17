# NOTES

Running log of migration decisions, measurements, drift, and quirks.

---

## Migration from the local-first build

The repo this project inherited was a complete, working build of a different
spec: single-user, single-machine, SQLite + Ollama + a desktop worker
process + a cloudflared tunnel for publishing. That spec has been superseded
by the one in `AGENTS.md` — Vercel + Supabase + Gemini-only, cloud-hosted,
no local model tier. The two are incompatible at the infrastructure level
(there is no Ollama on a Vercel function, no persistent worker process, no
local SQLite file to open), so this was a rewrite of the foundation, not an
incremental change.

**What happened to the old code:** moved to [`legacy/`](legacy/) via `git
mv`, not deleted. Nothing is lost — it's excluded from the build
(`tsconfig.json` excludes it, `eslint.config.mjs` ignores it) but still
there to read prompts, formulas, and UI patterns back out of as each stage
is rebuilt.

**What was kept as-is** (infrastructure-independent, copied to its original
path): `components/ui/primitives.tsx`, `components/ui/data.tsx`,
`app/globals.css` (the "instrument panel" design system), `lib/utils.ts`,
`lib/providers/types.ts` and `lib/providers/guard.ts` (the
`ALLOW_PAID_PROVIDERS` guard — pure logic, no infra assumption),
`lib/bootstrap-env.ts`.

**What was replaced:**

| Old                                                                                      | New                                                            | Why                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `better-sqlite3` + `drizzle-orm/sqlite-core`                                             | `postgres` (postgres-js) + `drizzle-orm/postgres-js`, Supabase | Cloud DB, per the spec                                                                                                                                                 |
| A persistent `scripts/worker.ts` (node-cron, infinite drain loop)                        | Time-boxed `runTick()` invoked by cron/webhook/API route       | Vercel functions have a wall-clock ceiling; nothing can block indefinitely                                                                                             |
| Two model tiers (Gemini + local Ollama, with A→B fallback)                               | Gemini only                                                    | No local tier is reachable from a serverless function                                                                                                                  |
| `whisper.cpp` reel transcription                                                         | Removed entirely                                               | Spec: "Reels: caption-only analysis for v1 (no transcription)"                                                                                                         |
| `cloudflared` tunnel (for Graph API to reach a local dev server)                         | Removed                                                        | Vercel deployments are already publicly reachable over HTTPS                                                                                                           |
| `node-notifier` desktop notifications                                                    | Removed                                                        | Not in the spec; no desktop to notify from a serverless deployment                                                                                                     |
| Embed (Ollama `nomic-embed-text`) → cluster → name-once → assign-by-proximity archetypes | Flat per-post Gemini hook classification (`hook_labels` table) | Spec: "Use per-post LLM classification (matching Growy's presumed approach)" — this is a deliberate simplification to match Growy's approach, not an enhancement of it |
| `archiver` zip export for a "manual publish" fallback mode                               | Removed                                                        | Spec always publishes via the Graph API; no manual mode described                                                                                                      |
| Local asset files (`draft_assets.local_path`)                                            | Supabase Storage (`draft_assets.storage_path` + `public_url`)  | Vercel functions have no persistent filesystem                                                                                                                         |

**What's new** (not present in the old build at all): hashtag-based
competitor/niche discovery (Stage 3), the Apify webhook receiver for
async scan completion (Stage 2), `CRON_SECRET`-gated cron endpoints (the
only thing standing between a cron-only route and the public internet,
since the app has no auth at all).

**Deliberately deferred to their build-order stage**, not attempted in this
pass: the scan pipeline, competitor discovery, hook classification, the
analysis engine, draft generation, slide rendering, chat, and Graph API
publishing. Building all eight stages in one pass would violate the spec's
own gating requirement ("do not start a stage until the previous one is
demonstrably working"), so Stage 1 is scoped to exactly what its own
description says: schema, jobs infrastructure, and the keepalive cron.

---

## Stage 1 — verified

- `npm run db:migrate` applied cleanly to a real local Postgres 16 (not just
  `drizzle-kit generate` succeeding) — all 16 tables landed with the
  expected columns, indexes, and foreign keys.
- `/api/cron/keepalive` was hit manually against that database: first call
  wrote a `settings` row (`keepalive.last_run`), second call's count query
  confirmed the row persisted. This is a real write, not a ping — it will
  keep a free Supabase project from pausing after 7 days idle.
- The `CRON_SECRET` guard was verified three ways against a running dev
  server: no `Authorization` header → 401, wrong bearer token → 401,
  correct token → 200. Unset `CRON_SECRET` (local dev default) → allowed,
  by design.
- `lib/jobs/queue.ts`'s atomic claim uses `FOR UPDATE SKIP LOCKED` — this
  wasn't exercised under real concurrency in this stage (no handlers are
  registered yet beyond `noop`), so treat it as typechecked-and-reasoned
  rather than load-tested; a concurrency test belongs with Stage 2, where a
  scan job and a publish tick can plausibly race for real.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`,
  and `npm run build` all pass. CI (`.github/workflows/ci.yml`) runs the
  same five checks on every push.

---

## Stage 2 — Apify scan pipeline, verified

- **Two-phase fire-and-webhook design.** `scanAccount` (`lib/jobs/handlers/scan.ts`)
  branches on `SCRAPE_MODE`: fixture/fake completes synchronously within the
  same invocation (it's instant — no real network call), while live mode
  fires the Apify actor via `ApifyScraper.start()` (not the blocking `.call()`
  the old local-first build used, which would exceed a Vercel function's
  duration ceiling) and immediately calls `markWaiting()` + throws `JobWaiting`
  so the runner leaves it alone. `/api/webhooks/apify` is what Apify calls
  back on `ACTOR.RUN.SUCCEEDED`/`FAILED`/etc.; it looks up the waiting job by
  `checkpoint->>'runId'`, fetches the dataset, and finishes the job itself.
- **Real end-to-end verification, not just unit tests.** Started the dev
  server against the same local Postgres from Stage 1, POSTed a handle to
  `/api/scan`, and confirmed in psql that all 6 fixture posts landed with
  correct types/likes, the scan job reached `done`, and a `compute_features`
  job was chained — see the table dump this produced, reproduced here for the
  record: `CTest0001` reel, `CTest0002` carousel (3 slides), `CTest0003`
  image, `CTest0004` reel, `CTest0005` image, `CTest0006` reel.
- **43 tests**, all against a real Postgres (not mocked): pure-function tests
  for `normalizeDataset`/`normalizePostType` against a hand-written fixture
  (`fixtures/testaccount.json`, modeled on realistic Instagram-scraper field
  names — `shortCode`, `productType: "clips"`, `childPosts`, etc.), DB
  integration tests for `upsertAccount`/`upsertPosts` idempotency, queue
  primitive tests (including that `FOR UPDATE SKIP LOCKED` genuinely prevents
  two concurrent `claimNext()` calls from claiming the same row), a
  fixture-mode scan-pipeline test (fire → complete in one tick), and a
  webhook test that mocks `ApifyScraper.fetchRun` and drives
  `POST /api/webhooks/apify` directly to exercise the fire → webhook →
  complete half the fixture path can't reach.
- **Two real Postgres bugs surfaced only by testing against a real database**
  (a fake/in-memory DB would not have caught either): `claimNext()`'s
  `type = ANY($1)` with a JS array parameter produced `malformed array
literal` from postgres-js — fixed by building an `IN (...)` list with
  `sql.join` instead. And `db().execute(sql\`...RETURNING *\`)`returns raw
snake_case columns, not drizzle's camelCase-mapped rows —`hydrate()`was
silently returning a`Job`whose`maxAttempts`was`undefined`, which made
`fail()`'s exhausted-retry check always false. Now `hydrate()` maps every
  column by hand.
- **`vitest.config.ts` needed `fileParallelism: false` restored.** The
  Stage 1 rewrite of this file dropped it; several test files share one real
  Postgres database (there's no per-file sandbox), so parallel files let one
  file's `afterEach` cleanup race another file's assertions — this produced
  confusing, file-order-dependent failures until traced back to this.
- **The dashboard now has the spec's actual input surface**: one field (an
  Instagram handle), no password, no OAuth — `components/scan-form.tsx`
  POSTs to `/api/scan`.

---

## Stage 3 — competitor/niche discovery, verified

- **Niche inference is one Gemini call** (`lib/analysis/niche.ts`) over the
  self account's bio, up to 50 recent captions, and its top 8 hashtags —
  matches the spec's "single model call" requirement exactly. Goes through
  the same `complete()`/quota/repair-on-malformed-JSON path everything else
  will use in Stage 4.
- **Hashtag discovery is deterministic** (`lib/analysis/hashtags.ts`,
  `topHashtags`/`rankAccountsByEngagement`) — no model involved in deciding
  which hashtags matter or which accounts dominate them, matching "scraping
  the account's most-used hashtags and ranking the accounts that dominate
  those hashtags by engagement." Engagement score weights comments 3x likes
  (a comment costs more effort than a like — a reasonable, documented,
  entirely swappable heuristic, not a spec requirement).
- **`discover_competitors` polls its own children rather than blocking.**
  It enqueues one `scan_hashtag` job per top hashtag (priority 10, vs. its
  own priority 0, so children are always claimed first within a tick), then
  throws `JobYield` to hand control back. On resumption it checks whether
  all children have reached `done`/`failed`; if not, it yields again. This
  is the same non-blocking shape as the Stage 2 scan, generalized to a
  fan-out/fan-in rather than a single external wait. `JobYield` gained an
  optional `delaySeconds` (default 5) to support this — the parent yields
  with `delaySeconds: 0` on its first pass, which is safe specifically
  _because_ of the priority ordering, not despite it.
- **`scan_hashtag` reuses the exact fire-and-webhook shape from Stage 2**
  (`ApifyScraper.startHashtag()`, generalized `/api/webhooks/apify` that now
  looks up the waiting job by type _and_ checkpoint `runId` rather than
  assuming `scan_account`) — deliberately not a second parallel mechanism.
- **Two more real bugs, both only caught by testing against a real
  database with realistic multi-entity data** (a single-account test
  wouldn't have caught either): `enqueue(..., {dedupe:true})` matched on job
  _type_ only, so enqueueing four `scan_account` jobs for four different
  discovered competitors silently dropped three of them — the second call
  found "an unfinished job of this type" (the first competitor's) and
  skipped. Fixed to match on type _and_ payload (`tests/jobs-queue.test.ts`
  now asserts both: same-type-same-payload dedupes, same-type-different-
  payload does not). And `quota_budget` rows were never cleared between
  test files, so repeated local `vitest run`s within the same calendar day
  accumulated real consumption against the self-imposed daily allowance
  until a later test file's LLM call legitimately hit `QuotaExhausted` —
  not a code bug, but a real testing-hygiene gap; `niche.test.ts` and
  `discover-competitors.test.ts` now clear `quota_budget` in `afterEach`.
- **Full pipeline verified against a real dev server + real Postgres**, not
  just tests: scanned `@testaccount` (`fixtures/testaccount.json`, whose top
  hashtags are `#reels #photography #advice #bts #dmfunnel` — five new
  hashtag fixtures were added to back this, distinct from the
  `hashtag-niche1`/`niche2` fixtures the unit tests use). Confirmed in
  psql: niche was written to the account row, all 5 hashtag scans completed,
  6 competitors were discovered and correctly tagged with
  `discovered_via_hashtag`, `testaccount` itself was correctly excluded from
  its own discovery results despite appearing in the `#reels` hashtag
  fixture data, and a `scan_account` job was chained for each competitor
  (which then correctly and honestly fail — fixture mode refuses to
  fabricate data for a handle it has no captured fixture for, which is by
  design, not a bug: a real deployment would either have a live Apify token
  or would need each new competitor's fixture captured once).
- **Added `/api/jobs/tick`** (`CRON_SECRET`-gated, like the keepalive route):
  advances the queue by one time-boxed tick regardless of job type. This is
  the general "short invocation" half of the fire-and-return pattern the
  spec calls for — `/api/scan` only ticks `scan_account` types for a fast
  first response, so something has to advance the `discover_competitors` →
  `scan_hashtag` → competitor `scan_account` chain afterward. In production
  this would be polled by the dashboard while a job is active, or hung off
  a cron schedule.

---

## Deviations from the spec

- **`eslint-config-next` ships a native flat-config export** in the
  installed version (16.3.1) — `eslint-config-next/core-web-vitals` is
  already an ESLint 9 flat-config array. The `@eslint/eslintrc`
  `FlatCompat` shim (the documented approach for older Next versions)
  throws `Converting circular structure to JSON` against this version, so
  `eslint.config.mjs` imports the flat exports directly instead.
- **`checkpoint`/`waiting` is exercised by the webhook test, but only with a
  mocked Apify client.** `markWaiting()` → `claimNext()` correctly excludes
  the job → `resume()` puts it back is unit-tested (`tests/jobs-queue.test.ts`).
  The full round trip against a real Apify actor run and a real inbound
  webhook POST is not — see "Not yet exercised against reality" below.
- **No handler is registered for most `JobType`s yet.** `lib/jobs/registry.ts`
  and `lib/jobs/types.ts` declare the full job-type surface up front (so the
  schema doesn't reshape later); `noop` and `scan_account` are implemented as
  of Stage 2. `runTick()` will `fail()` any other type permanently right now
  — expected until each stage adds its handler. `compute_features` is
  enqueued at the end of every scan but has no handler yet, so it sits
  `pending` until Stage 4 registers one — by design, not a bug.

---

## Not yet exercised against reality

- **Supabase.** Migrations were run against a local Postgres 16, not an
  actual Supabase project — no Supabase project exists yet for this build.
  The connection-pooler assumptions in `lib/db/client.ts`
  (`prepare: false`, transaction-mode pooling) are standard Supabase
  guidance but unverified against a real pooler.
- **Vercel Cron.** `vercel.json`'s schedule and the `CRON_SECRET` header
  contract are per Vercel's documented behavior, not yet deployed and
  observed.
- **A real Apify actor call**, for both the profile-posts actor and the
  hashtag actor (`startHashtag()`, `APIFY_HASHTAG_ACTOR`). Input/webhook
  shapes are best-effort from Apify's documented client API, not verified
  against a real actor run — no `APIFY_TOKEN` exists for this build yet.
  `posts.raw` keeps the untouched payload precisely so re-normalisation after
  drift costs nothing. The webhook _receiver_ is tested (mocked client), but
  the actual webhook _delivery_ from Apify to a deployed `/api/webhooks/apify`
  is not — that needs a real public deployment to observe. In particular,
  whether `apify/instagram-hashtag-scraper` (or whatever hashtag actor ends
  up configured) accepts a bare `hashtags: [tag]` input the way assumed here
  is unverified.
- **Gemini.** No live call yet — `GoogleLlm` is written and typechecked
  (`lib/providers/llm/google.ts`) but every test in Stage 3 runs against
  `FakeLlm`; no `GOOGLE_GENERATIVE_AI_API_KEY` exists for this build yet.
