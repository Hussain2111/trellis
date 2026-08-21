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

## Stage 4 — analysis engine, verified

The core deliverable of the whole build, and the one the spec asks to be
held to the highest bar: "the evidence-reconciliation check... passes before
this stage is considered done." It does — see below.

- **Layer A (deterministic, unit-tested)**: `lib/analysis/features.ts` —
  ported from the legacy build with `Date` in place of unix-epoch integers.
  Per-post features (hook text, hashtag/mention/emoji counts, CTA and
  question detection via regex, posting hour/day, follower-normalized
  engagement rate) and `markOutliers()` (a post's own trailing median ×
  multiplier — "my winners" relative to _this account's_ history, not an
  absolute threshold that would never fire for a small account).
- **Layer B (per-post Gemini classification)**: `lib/analysis/hooks.ts` +
  `lib/prompts/hook-classification.v1.ts` classify every post's opening line
  into one of a **fixed** 10-category taxonomy (question, bold_claim,
  curiosity_gap, controversy, personal_story, how_to, listicle,
  before_after, relatable_pain_point, other) — a deliberate choice: an
  open-ended taxonomy would give every post its own one-off label and
  nothing would aggregate into "51% use X, you use it 20%". One Gemini call
  per post, exactly as the spec asks. `classify_hooks`
  (`lib/jobs/handlers/classify-hooks.ts`) processes 5 posts per tick then
  yields — no checkpoint needed between ticks, since "the next unclassified
  post" is itself the durable state, held in `hook_labels`.
- **Layer C (deterministic pattern engine + validated LLM phrasing)**:
  `lib/analysis/patterns.ts`'s `computePatterns()` is pure and
  fixture-free-testable — 5 dimensions (dominant hook category, dominant
  format, dominant posting-hour bucket, CTA presence, question presence),
  each measured on the **top quartile of competitor posts by engagement**
  (never the account's own posts — "what works in the niche" can't be
  defined by the account being benchmarked against it) vs. the account's own
  rate, ranked by absolute percentage-point delta. `patterns[0]` **is** "the
  single biggest gap" — not a separate computation, so it can never
  disagree with the pattern list by construction.
- **The receipts are real, not decorative.** Every pattern's `nichePostIds`/
  `myPostIds` are the _specific_ posts satisfying that pattern's predicate
  (the numerator, not just the denominator) — `lib/analysis/reconcile.ts`'s
  `reconcilePatterns()` re-derives each pattern's predicate from its `key`
  independently (`predicateForKey`, the same function `computePatterns` used
  to build it) and checks three things per pattern: every listed post id
  exists in the corpus, every listed post id actually satisfies the
  predicate, and the stored stat matches `postIds.length / sampleSize`
  recomputed from scratch. `tests/reconcile.test.ts` proves each of the
  three checks actually fires on tampered data, not just that a clean
  pattern set passes.
- **The claim sentence never lets the model's arithmetic be the source of
  truth.** `lib/analysis/gap.ts`'s `phraseClaims()` asks Gemini to phrase
  one sentence per pattern (the "one Tier A call over the compact
  aggregates" shape from the legacy build's design, carried forward), but
  validates every returned claim actually cites both rounded percentages
  (±1 point) before trusting it — a claim that fails validation, or a model
  call that fails/returns malformed JSON entirely, falls back to a
  deterministic template that states the exact numbers. `tests/gap-analysis.test.ts`
  covers all three paths: a valid LLM claim used as-is, an invalid one
  (invented numbers) replaced per-claim, and a total call failure falling
  back for every pattern.
- **Back-catalogue mining is fully deterministic** (`lib/analysis/back-catalog.ts`,
  no model call): groups the self account's posts by hook category, finds
  each category's best-ever ("outlier") post, and flags categories whose
  most recent post is older than the stale threshold — "your DM-funnel reel
  hit 552K, you haven't made one like it in 30 days" is exactly this shape.
  `persistBackCatalog()` clears the account's prior `resurfaced_posts` rows
  before writing new ones — proven idempotent in `tests/back-catalog.test.ts`,
  since a naive insert-only version would accumulate duplicates on every
  analysis run.
- **The job chain (`compute_features` → `classify_hooks` → `run_analysis`)
  is tested by driving it through the actual queue** (`enqueue()`/`runTick()`,
  never calling handler functions directly) in
  `tests/analysis-job-chain.test.ts` — the spec specifically calls out the
  job pipeline as "the part most likely to break silently on Vercel's
  function-timeout model," so this is deliberately not a shortcut around
  that risk.
- **Verified against a real dev server + Postgres**: scanned `@testaccount`,
  ticked the queue repeatedly, and confirmed features and hook labels were
  computed for the self account. `run_analysis` correctly stayed `pending`
  with a `JobYield`-driven wait rather than failing, since fixture mode
  can't produce data for the newly-discovered competitor handles (no
  fixture files exist for them) — `InsufficientData` is handled as a
  30-second retry, not an error, which is the correct behavior for "not
  enough data exists yet" as distinct from "something is broken." The
  full successful-completion path (patterns computed, reconciled, and
  persisted end to end) is covered by seeding real competitor data in
  `tests/gap-analysis.test.ts` and `tests/analysis-job-chain.test.ts`
  instead, rather than hand-writing six more competitor fixture files for
  one manual run.

---

## Stage 5 — draft generation, verified

- **Voice profile** (`lib/analysis/voice.ts`, ported to async Postgres):
  one Gemini call over the self account's best-performing captions
  (`topCaptionsForVoice`, likes-ranked, >40 chars so junk/empty captions
  don't dilute it). Versions are never overwritten — `saveVoice()`
  deactivates the previous version rather than replacing it, so a
  regeneration you dislike is a revert, not a loss (tested).
- **Format mix matches the account's own proportions**, per the spec
  exactly: `lib/analysis/format-mix.ts`'s `formatMix()` scales the
  account's reel/carousel/image split to the requested batch size using
  largest-remainder rounding — the only rounding method that both matches
  proportions closely _and_ guarantees the output sums to exactly the
  requested count (12) every time, which naive per-format `Math.round()`
  does not (it can over- or under-shoot the total). `video`/`unknown` post
  types fold into `image`, since the draft schema only has three formats.
- **Every draft is tied to exactly one of the analysis's 5 patterns**
  (`pattern_index`), closing the gap analysis identified — matches "12
  drafts/week aimed at closing the biggest identified gap." The prompt
  (`lib/prompts/draft-generation.v1.ts`, carried over from the legacy
  build's design) generates in batches of 4 rather than 12-at-once, since
  smaller structured outputs fail schema validation far less often and
  every retry spends quota.
- **Draft evidence is filtered, not trusted.** A draft's `evidence` (post
  ids the model claims support it) is intersected against posts that
  actually exist before storage — a hallucinated id never reaches the
  database. `pattern_index` is clamped to the analysis's actual pattern
  count for the same reason: the schema only bounds it to 0-4 in general,
  not to how many patterns _this_ analysis has.
- **The full automatic chain** (`run_analysis` → `build_voice_profile` →
  `generate_drafts`) is driven through the real job queue in
  `tests/draft-job-chain.test.ts`, the same discipline as Stage 4's chain
  test. One real bug surfaced only by testing the chain end-to-end rather
  than each handler in isolation: the debugging session (a throwaway
  `scripts/debug-chain.ts`, since deleted) revealed `build_voice_profile`
  silently yielding for 30 seconds per attempt because the test fixture's
  captions were under the 40-character floor `topCaptionsForVoice` filters
  on — not a code bug, but exactly the kind of silent stall the spec warns
  the job pipeline is prone to, caught by asserting on wall-clock-bounded
  test behavior rather than trusting a single `runTick()` call to finish
  everything.
- **Not independently re-verified against a live dev server for this
  stage.** Stage 4's live run already proved the scan → features → hooks →
  analysis half of the chain against a real Postgres; reaching
  `generate_drafts` live would need at least one competitor account with
  real fixture data (the discovered competitors from Stage 3's live run
  have none), which the automated `tests/draft-job-chain.test.ts` already
  covers by seeding real competitor posts and driving the _entire_ chain
  through the actual queue — building six more competitor fixtures for one
  redundant manual check wasn't worth it. Nothing here is asserted without
  having actually run.

---

## Stage 6 — slide rendering, verified

- **Slide text is always rendered in code, never by a model** — satori
  (React → SVG) + resvg (SVG → PNG), ported from the legacy build almost
  unchanged since neither library cares about SQLite vs. Postgres. Only the
  _background_ may come from a free image model
  (`IMAGE_PROVIDER=pollinations`, keyless, no SLA); `none` (the default) is
  a deterministic palette gradient and is fully functional, not a degraded
  mode — matches the spec's "diffusion models are unreliable at
  letterforms" reasoning exactly.
- **Storage moved off the local filesystem, the one piece of the legacy
  design that couldn't survive the infra pivot unchanged.** Vercel
  functions have no persistent disk. `lib/storage/index.ts` uploads to
  Supabase Storage when credentials are configured; without them (true for
  this build — no Supabase project exists yet) it falls back to writing
  under `./data/assets` and serving it back through
  `/api/assets/[...path]`, a dev convenience gated behind the same
  credential check, not a second production code path. The fallback route
  has a path-traversal guard (`resolved.startsWith(...)`) since it serves
  arbitrary sub-paths from a request.
- **Idempotent by construction**: `render_slides` deletes a draft's prior
  `draft_assets` rows before writing new ones, tested by asserting a
  second render doesn't accumulate duplicates (the same pattern as Stage
  4's back-catalogue persistence).
- **Visually inspected, per the spec's own instruction that this is "the
  one stage worth eyeballing rather than just testing programmatically."**
  Rendered a hook, a body, and a CTA slide via a throwaway script (since
  deleted) and viewed all three: headline legible at 92px, body text at
  36px with proper line-height, the progress-dot indicator correctly
  tracks position (2/5) and is correctly omitted on the CTA slide, and the
  palette gradient background gives real depth without threatening
  legibility. Screenshots weren't saved — the point was human eyes on
  actual output, not another artifact to maintain.
- **Also tested programmatically** (`tests/render-slides.test.ts`): a real
  render produces a file starting with the actual PNG magic bytes
  (`89 50 4E 47 0D 0A 1A 0A`) over 1KB, not an empty stub; slide count
  matches hook + body-slides + cta exactly; a non-carousel draft (reel,
  image) no-ops cleanly rather than erroring, since only carousels have
  slides to render.

---

## Stage 7 — chat coach, verified

- **Streaming, not the job queue.** Every other model call in this build
  goes through a job handler because it can outlive a single HTTP request.
  A chat turn can't wait behind that — the user is watching it type — so
  `app/api/chat/route.ts` talks to the AI SDK's `streamText` directly over
  a raw provider model (`lib/providers/llm/chat-model.ts`), separate from
  `lib/providers/llm`'s one-shot `complete()` used everywhere else. It
  still goes through the same quota ledger (`checkHeadroom`/`consume` on
  `('google', 'chat')`) so a chat binge can't blow the day's Gemini
  allowance out from under the analysis pipeline.
- **One tier, no silent fallback.** The legacy build had a local-Ollama
  tier to fall back to; this deployment has none. `checkHeadroom` failing
  returns a 429 with the exact reset time in the body, not a degraded
  response — the spec's "never guess when you don't know" principle
  applied to availability, not just content.
- **Read-only tool surface, a deliberate narrowing from the legacy
  build.** `lib/chat/tools.ts` exposes 7 tools — `getAccountStats`,
  `getPosts`, `getCompetitorStats`, `getCurrentGap`, `getMyWinners`,
  `getDrafts`, `listAccounts` — all pure reads over data this build
  already computed, so no tool call spends a single unit of model quota.
  The legacy version also had tools that created/edited/scheduled drafts
  and triggered rescans; the spec's chat section only asks for
  "grounded... advisory" coaching, and "no extra features beyond what's
  listed" was read as ruling those out here. Nothing stops a future stage
  from adding them back deliberately.
- **The system prompt is grounded in real state, never placeholders** —
  `lib/chat/threads.ts`'s `buildSystemPrompt()` pulls the self account,
  the latest analysis's gap claim (or an explicit "no analysis yet"
  sentence), the voice profile, and today's date fresh on every turn.
  Tested by asserting the literal handle/follower count/niche/gap-claim
  text appears in the rendered prompt, not by asserting a length or a
  vibe (`tests/chat.test.ts`).
- **Never trust model arithmetic, chat edition.** The gap `claim` string
  surfaced to the model was already validated against its own numbers
  back in Stage 4 (`claimMentionsBothStats`) before it was ever persisted
  — the chat layer inherits that guarantee for free by only ever quoting
  the stored claim, never re-deriving percentages itself.
- **UI**: `app/chat/page.tsx` (server component — lists threads, resolves
  the active one from `?thread=`, loads its history) plus
  `components/chat-panel.tsx` (client — thread sidebar with create/delete,
  and the streaming conversation via `@ai-sdk/react`'s `useChat` against
  `DefaultChatTransport({ api: '/api/chat', body: { threadId } })`).
  Matches the existing instrument-panel design system (`Panel`,
  `PanelHeader`, `Badge`, dark surfaces, amber signal accent) rather than
  introducing a new visual language for one page. Thread create/delete go
  through two small new routes, `app/api/chat/threads/route.ts` (GET
  list, POST create) and `app/api/chat/threads/[id]/route.ts` (DELETE) —
  the only state-changing surface added this stage beyond the chat route
  itself.
- **Smoke-tested against a real dev server and a real Postgres database**
  (no browser-automation tooling is installed in this project — it's a
  server-rendered dashboard with no existing UI test infra, so this was a
  manual `curl` pass, not a new dependency added just for one check):
  `GET /chat` renders the panel chrome (`Threads`, `Coach`, the message
  input) server-side; `POST /api/chat/threads` creates a real row and
  `GET` lists it back; `POST /api/chat` returns a `text/event-stream`
  response using the AI SDK's UI-message-stream protocol
  (`x-vercel-ai-ui-message-stream: v1`) and, with no real
  `GOOGLE_GENERATIVE_AI_API_KEY` configured in this environment, surfaces
  a clean `{"type":"error"}` frame rather than crashing — exactly the
  shape `components/chat-panel.tsx`'s `error` state is built to render.
  This confirms the quota gate, the streaming wire format, and the error
  path all work end-to-end; it does not confirm output quality from a
  real Gemini response, which needs a real key.
- **Also tested programmatically** (`tests/chat.test.ts`, 11 tests): thread
  CRUD, system-prompt grounding, all 7 coach tools called directly and
  asserted against real inserted rows (including the `getCompetitorStats`
  bug below), and two route-level tests using `MockLanguageModelV4` from
  `ai/test` — one full happy-path stream that asserts both turns end up
  persisted and the thread gets auto-titled from the first message, one
  quota-exhausted 429.
- **A real bug, caught by testing against real inserted rows rather than
  mocks**: `getCompetitorStats` only ever queried
  `competitorAccountIds[0]` — the first competitor account — for a pool
  that's supposed to cover all of them. A test inserting two competitors
  and asserting the tool's `byFormat` reflects both accounts' posts would
  have silently passed against a mock returning canned data; against a
  real multi-account fixture it failed immediately. Fixed with
  `inArray(posts.accountId, competitorAccountIds)`.

---

## Stage 8 — scheduling + publishing, verified

- **No cloudflared tunnel — the one piece of the legacy publish design that
  simply doesn't apply anymore.** The local-first build needed a quick
  tunnel because Meta's Graph API cannot fetch media from `localhost`; this
  app is already deployed at a public HTTPS URL, so `draftAssets.publicUrl`
  (Supabase Storage, or the `/api/assets/...` dev fallback) is directly
  postable. `lib/publish/graph.ts` is otherwise a near-verbatim port of the
  legacy Graph API client — container create → poll → publish, carousel
  children-then-parent — since that part of the design never depended on
  SQLite or a local worker.
- **`ENABLE_IG_PUBLISHING=false` (the default) is the spec's "manual/watched
  first publish" framing enforced in code, not just a suggestion.**
  `publish_due` treats a disabled flag as a clean no-op, not an error: due
  rows stay `pending` and wait. Turning the flag on is a deliberate,
  separate act from scheduling a post — scheduling never implicitly enables
  live publishing.
- **A real gap in Stage 6, closed here.** `slidesForDraft` already produced
  a valid hook(+CTA) slide for a non-carousel draft — the carousel-body loop
  is just skipped when `body.kind !== 'carousel'` — but `render_slides`
  unconditionally skipped every non-carousel format, so `image` drafts (the
  most common single-post format) could never have anything to publish.
  Fixed by only skipping `reel`, which genuinely has nothing to render (no
  video pipeline exists in this stack). A single `image` draft now renders
  as a 1–2 slide "carousel" (hook, optionally CTA) and publishes as one
  container using the hook card. `reel` drafts fail _permanently_ at
  publish time with a clear "no rendered assets" error rather than silently
  doing nothing — consistent with "never guess when you don't know."
- **The claim-then-publish step for `schedule` rows reuses the exact
  `FOR UPDATE SKIP LOCKED` pattern `lib/jobs/queue.ts`'s `claimNext` already
  established** (`lib/publish/schedule.ts`'s `claimDueForPublish`), so a
  cron sweep and a dashboard-triggered tick landing at the same moment can't
  double-publish the same row. Also reused: aliasing the `RETURNING` clause
  to camelCase (`draft_id AS "draftId"`) instead of hand-writing a
  `hydrate()` mapper — the fix for the exact snake_case bug Stage 2 hit,
  applied proactively here since the shape needed was small enough not to
  warrant its own mapper function.
- **Cron frequency is Vercel Hobby's real, load-bearing constraint here,
  not just a documented unknown.** Hobby cron jobs run once a day at most,
  so `/api/cron/publish` alone gives same-day (not same-minute) publish
  latency. The calendar UI (Stage 21) mitigates this the same way the scan
  flow already does — it pokes `/api/jobs/tick` while open — but a
  scheduled post published while nobody has the app open can lag up to a
  day behind its scheduled time. This is an accepted, documented trade-off
  of staying at $0, not a bug.
- **Test seam, same shape as `chat-model.ts`'s `__setChatModelForTests`.**
  `lib/publish/graph.ts` exports `__setGraphFetchForTests` to swap in a fake
  `fetch` — there's no existing DI pattern in this codebase for a raw-fetch
  provider (Apify goes through the `apify-client` SDK instead), so this
  establishes one, consistent with the existing override-seam convention
  rather than introducing a new mocking library.
- **Tested against real Postgres and a fake Graph API** (`tests/publish.test.ts`,
  24 tests): `lib/publish/graph.ts`'s container lifecycle, error
  classification (400 permanent vs. 429 not), `publishingLimit` degrading to
  `null` rather than throwing, `inspectToken` on valid/invalid/network-error
  tokens; `lib/publish/schedule.ts`'s full CRUD plus a concurrency
  assertion that a second `claimDueForPublish` finds nothing once a row is
  claimed; the `publish_due` handler's disabled/no-token/single-image/
  carousel/no-assets paths, including verifying a carousel with 3 slides
  makes exactly 4 `/media` calls (3 children + 1 parent); `refresh_ig_token`
  on valid, invalid, and disabled paths, asserting the actual `runs` row
  each leaves behind.
- **Smoke-tested against a real dev server and real Postgres, no live
  Instagram credentials**: scheduled a real draft via `POST /api/schedule`,
  confirmed it appeared via `GET`, marked it posted via `PATCH .../[id]`
  (the manual-mode path), unscheduled a second one via `DELETE`, and hit
  `GET /api/cron/publish` directly — confirmed both `publish_due` and
  `refresh_ig_token` ran and no-opped cleanly with `ENABLE_IG_PUBLISHING`
  unset, leaving the exact job labels asserted in the handler tests.

---

## UI pages — posts, competitors, gap, voice, drafts, calendar, settings

Stages 3–6 and 8 shipped their backend and job-queue machinery without a
matching page — `Nav` (Stage 1) already listed every route, but only the
dashboard and chat existed. This closes that gap: all seven remaining
routes now read from the tables and lib functions those stages already
built, with no new business logic — every page is a thin display over an
existing query or analysis function (`summariseByFormat`, `poolComposition`,
`latestAnalysis`, `activeVoice`, `scheduledRows`, `monthlyCostSummary`,
`recentRuns`), the same "chat tools are read-only, no new computation"
discipline Stage 7 established, just applied to server components instead
of AI SDK tools.

- **`/posts`** — the self account's posts joined with `post_features` and
  `hook_labels`, format summary at the top via `summariseByFormat`. Outlier
  ("winner"), CTA, and question badges surface the exact booleans the
  pattern engine itself reads, so what the UI shows and what the analysis
  actually used to compute a claim are provably the same data.
- **`/competitors`** — the competitor pool plus `poolComposition()`'s
  `PoolWarning` (the "only 2 competitors scanned, treat this as noisy"
  message from Stage 4), each account tagged with the hashtag it was
  discovered through.
- **`/gap`** — the headline gap's claim text plus all 5 ranked patterns, each
  with niche% vs. your% (via the `Share` component — a percentage is never
  shown without its sample size) and a `Receipts` component listing the
  actual backing post ids (capped at 8 with a "+N more" tail) — the spec's
  "receipts" requirement made literally clickable-numbers-visible, not just
  computed-and-trusted.
- **`/voice`** — the active profile's markdown plus every structured field
  (tone, vocabulary, banned words, etc.), version-badged since `saveVoice`
  never overwrites a prior version.
- **`/drafts`** — every draft with format-specific body rendering (carousel
  slide list, reel beats + on-screen text, image concept/direction),
  rendered slide thumbnails pulled straight from `draftAssets.publicUrl`,
  and a `ScheduleDraftForm` client component wired to `POST /api/schedule`
  for any draft still in `draft`/`approved` status.
- **`/calendar`** — `scheduledRows()` with unschedule and mark-posted
  actions (`DELETE`/`PATCH /api/schedule/[id]`, the Stage 8 API), and a
  `CalendarTickPoller` client component that pokes the job queue every 20s
  while the page is open.
- **`/settings`** — the $0.00 cost check (`monthlyCostSummary`, badged red
  if `paidCallCount` is ever nonzero — the one thing this page exists to
  catch), every guard flag and provider (`ALLOW_PAID_PROVIDERS`,
  `ENABLE_IG_PUBLISHING`, `SCRAPE_MODE`, model/actor names), the most recent
  `token_check` run's status, and a table of recent provider calls. No
  secret values (API keys, tokens) are ever rendered — only booleans and
  provider identifiers.
- **A load-bearing correction to Stage 8's own NOTES entry, caught while
  building this.** Stage 8 said the calendar page would poke
  `/api/jobs/tick`, but that route is gated by `isAuthorizedCronRequest` —
  fine for Vercel's own cron caller, but a real problem for a browser tab,
  since a production `CRON_SECRET` would make every client-side poke 401.
  `/api/calendar/tick` is a new, deliberately unauthenticated route instead
  (same trust level as `/api/scan`, consistent with the spec's "no
  authentication of any kind"), doing nothing `/api/cron/publish` doesn't
  already also do on its own daily schedule.
- **Real, end-to-end smoke test, not just empty-state screenshots.** Ran a
  full scan against the dev server with `SCRAPE_MODE=fake` and
  `LLM_PROVIDER=fake` (fixture mode only has a profile fixture for
  `testaccount`, not for synthetic discovered competitors — fake mode
  generates competitor data too, which fixture mode doesn't), ticked the
  job queue until it settled, and confirmed every page renders real rows:
  `/gap` showing an actual computed claim and 5 patterns, `/voice` showing
  real extracted fields, `/drafts` showing 3 real carousel drafts with 15
  rendered slide thumbnails, `/competitors` showing discovered accounts,
  scheduled a real draft and watched it appear on `/calendar` with working
  unschedule/mark-posted buttons, and confirmed `/settings` reads $0.00
  with zero paid calls. All smoke-test rows were wiped afterward; the
  automated suite doesn't depend on any of them.

---

## Deviations from the spec

- **The 5 pattern dimensions and the fixed 10-category hook taxonomy are
  interpretive choices, not spec requirements.** The spec says "identify 5
  patterns... whatever the data supports" without naming them; hook
  category, format, posting-hour bucket, CTA presence, and question
  presence are what the currently-scanned data (captions + timestamps +
  engagement, no transcription) actually supports. The hook taxonomy is
  similarly a judgment call — a fixed enum was chosen deliberately over an
  open vocabulary specifically so percentages aggregate meaningfully; see
  the Stage 4 log above.
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

## Deployed to real infrastructure — first live bugs found

The app is now actually deployed to Vercel + a real Supabase project. Two
real, environment-only bugs turned up that no amount of local/CI testing
against fixtures could have caught, since both are about the shape of a
real external system rather than this codebase's own logic:

- **`apify/instagram-profile-scraper`'s real input schema uses `usernames`
  (plural), not `username`.** `ApifyScraper.start()` (`lib/providers/scraper/apify.ts`)
  sent `{ username: [handle], ... }`; the actor rejected every live run with
  `Input is not valid: Field input.usernames is required`. This is exactly
  the drift the code's own comment warned was unverified ("confirm against
  the actor's Store page and record drift in NOTES.md" — Stage 2). Fixed by
  renaming the field. No test caught this because every scan test runs
  against `FixtureScraper`/`FakeScraper`, which never construct a real Apify
  actor input payload — this class of bug is only reachable by a real
  `SCRAPE_MODE=live` run, which is why the spec's own fixtures-first
  discipline flags it as a known gap rather than a false sense of coverage.
  The hashtag actor's input shape (`startHashtag()`) is unverified for the
  same reason and may have the same class of bug — watch for it once
  competitor discovery runs live.
- **Vercel environment variable footguns, not code bugs, but worth recording
  since they cost real deploy cycles:** a variable marked "Sensitive" in
  Vercel's dashboard becomes write-only — its value can never be viewed
  again, only overwritten, which made a failed save indistinguishable from
  a successful one until the value was re-entered with Sensitive off. And a
  variable added without every target environment (Production vs. Preview
  vs. Development) checked silently doesn't apply to the environment you
  think it does. Neither is a Trellis bug, but `/settings` rendering the
  resolved `SCRAPE_MODE`/`ENABLE_IG_PUBLISHING`/etc. directly from
  `env()` turned out to be the actual reliable way to confirm a Vercel env
  var change had taken effect — more reliable than the Vercel dashboard
  itself, which is worth keeping in mind for any future config debugging.
- **Vercel Deployment Protection blocked Apify's webhook outright.** Once
  the actor input was fixed, the real scrape succeeded but the completion
  webhook still failed with `401 Protected deployment` —
  `vercel_auth_enabled: true` was gating every deployment behind Vercel's
  own SSO login, which an external service like Apify obviously can't
  satisfy. This is a project-level Vercel setting (Settings → Deployment
  Protection → Vercel Authentication), not application code. Turning it
  off (or scoping it to Preview only) is required for the webhook, and
  matches the app's own "no auth of any kind" design anyway.
- **A real architectural gap, found and fixed once a live scan actually
  worked**: the chain a scan enqueues after itself — `compute_features` →
  `classify_hooks` → `run_analysis` → `build_voice_profile` →
  `generate_drafts` → `render_slides` — had no automatic trigger in
  production. `/api/scan` only synchronously ticks the `scan_account` type
  it just enqueued; the Apify webhook receiver only resumes and completes
  that one waiting job. Every job type after that sat `pending` forever,
  since Vercel Hobby cron runs once a day and nothing else was polling the
  general queue — this class of bug was invisible in local/CI testing
  because manual `runTick()` calls (direct in tests, or hand-run ticks
  during dev) always advanced the whole chain artificially. Fixed the same
  way Stage 8/21 already solved this exact problem for the calendar page:
  a new unauthenticated `/api/pipeline/tick` (mirrors `/api/calendar/tick`)
  plus a `PipelineTickPoller` client component that pokes it every 10s
  while the dashboard is open, so the full pipeline actually finishes in
  the time a user is willing to watch it, not "sometime in the next 24
  hours." Also dropped the `stage 2 / 8` badge that had been hardcoded on
  the dashboard since Stage 1 verification — stale now that all 8 stages
  are built and deployed.
- **The client-side poller alone wasn't enough — a scan left overnight
  with no browser tab open sat stalled for 11 hours** on jobs
  (`compute_features`, mid-chain) that involve zero network calls and
  should take milliseconds. `PipelineTickPoller` only runs while the
  dashboard is actually open in a tab; nothing server-side was advancing
  the queue in the gap, and Vercel Hobby cron's once-a-day ceiling can't
  close that gap either — it's a hard cap per cron entry, not a count
  limit you can work around with more entries. Fixed with an external,
  Vercel-independent scheduler: `.github/workflows/pipeline-tick.yml`
  pings the same unauthenticated `/api/pipeline/tick` every 10 minutes via
  GitHub Actions' own cron, which isn't subject to Vercel's limit at all.
  Requires a `TRELLIS_URL` repo variable (Settings → Secrets and variables
  → Actions → Variables) pointing at the project's stable Production
  domain — not a per-deployment preview-style URL, which changes on every
  deploy and would silently break this.

## Not yet exercised against reality

- **Supabase.** Migrations were run against a local Postgres 16, not an
  actual Supabase project — no Supabase project exists yet for this build.
  The connection-pooler assumptions in `lib/db/client.ts`
  (`prepare: false`, transaction-mode pooling) are standard Supabase
  guidance but unverified against a real pooler.
- **Vercel Cron.** `vercel.json`'s schedule and the `CRON_SECRET` header
  contract are per Vercel's documented behavior, not yet deployed and
  observed.
- **The hashtag actor** (`startHashtag()`, `APIFY_HASHTAG_ACTOR`) — unlike
  the profile-posts actor (see above, now fixed and live-verified), the
  hashtag actor's input shape is still unconfirmed against a real run;
  whether `apify/instagram-hashtag-scraper` accepts a bare `hashtags: [tag]`
  input the way assumed here is unverified, and may have the same class of
  field-name drift the profile actor did. `posts.raw` keeps the untouched
  payload precisely so re-normalisation after drift costs nothing. The
  webhook _receiver_ is tested (mocked client), but the actual webhook
  _delivery_ from Apify to the deployed `/api/webhooks/apify` has not yet
  been observed end-to-end (a live scan's completion webhook firing
  correctly hasn't been confirmed as of this note).
- **Gemini.** No live call yet — `GoogleLlm` is written and typechecked
  (`lib/providers/llm/google.ts`) but every test in Stage 3 runs against
  `FakeLlm`; no `GOOGLE_GENERATIVE_AI_API_KEY` exists for this build yet.
  The same is true of `getChatModel()` (Stage 7) — the streaming chat
  route was smoke-tested end-to-end with no key configured, confirming
  the quota gate and error path, but no real Gemini response has been
  streamed through it yet.
- **The Instagram Graph API.** `lib/publish/graph.ts` and the `publish_due`
  / `refresh_ig_token` handlers are tested against a fake `fetch`
  (`tests/publish.test.ts`) that mirrors Meta's documented request/response
  shapes, and smoke-tested end-to-end with `ENABLE_IG_PUBLISHING` unset —
  neither exercises an actual container create, poll, or publish against a
  real Instagram Business account, since no `IG_USER_ID`/`IG_ACCESS_TOKEN`
  exists for this build yet. `docs/instagram-setup.md` documents the setup
  needed to change that. Whether `content_publishing_limit`'s response
  shape matches what `publishingLimit()` expects is likewise unverified
  against a real account.
- **Vercel's actual Hobby cron cadence and job-count limits.** `vercel.json`
  now declares two daily cron entries (`keepalive`, `publish`); both are
  per Vercel's documented Hobby-tier behavior (daily minimum interval), not
  yet deployed and observed running on a schedule.

---

## v2 — Task 0: removals and the calendar migration

v2 drops the generative half of the product and keeps the measurement half.
Gone: the Gap tab, the Voice tab, the Drafts tab, LLM draft generation,
Satori/resvg slide rendering, and the Supabase Storage layer that existed
only to hold rendered slide PNGs. `/posts` is dormant — the route still
renders the scraped back catalogue, but it is off the nav until the
Graph-API-sourced analytics views replace it.

### `drafts` + `schedule` → `calendar_entries`

v1 split a scheduled post across two tables: content on `drafts`, timing on
`schedule`, joined by a foreign key. That shape only made sense while the
content was generated. v2 entries are hand-written, so `calendar_entries`
owns its content inline and has no FK to anything.

The migration is two files but **one transaction** — drizzle's pg dialect
wraps every pending migration in a single `session.transaction()`
(`node_modules/drizzle-orm/pg-core/dialect.js`), so a failure anywhere leaves
the database untouched. That's what makes the guard in `0002` meaningful:

- `0001_calendar_entries.sql` creates the table and backfills it from
  `schedule JOIN drafts`, denormalising caption/hashtags/hook/format and
  collapsing each draft's rendered slide URLs into `media_urls`.
- `0002_drop_drafts_voice.sql` opens with a `DO` block that counts `schedule`
  rows against `calendar_entries` rows and `RAISE EXCEPTION`s if the backfill
  came up short, then drops `drafts`, `draft_assets`, `schedule`, and
  `voice_profile`.

Verified against a seeded database, not just read: slide URLs order by
`slide_index` with NULL-url and non-`slide` assets excluded, `pending` maps to
`planned`, `rationale` becomes `notes`, timestamps survive. A deliberately
broken backfill run through `npm run db:migrate` left `drafts` intact and
`calendar_entries` non-existent — the rollback is real.

**Caveat worth knowing:** the guard only protects you through
`npm run db:migrate`. Pasted into psql or the Supabase SQL editor, each
statement autocommits and the drops will run even after the exception. Run
migrations through the script.

Never-scheduled drafts are **not** migrated. v2 has no draft generation, so
there is no tab that would ever show them again; `0002` counts them and
`RAISE NOTICE`s the number before dropping.

### `analyses` survives, `gap` does not

`analyses` and `hook_labels` stay — Opportunities and the Ideas viral-score
view both need them. `runPatternAnalysis()` (was `runGapAnalysis`) still
writes `patterns` and now writes `gap: null`; the column was made nullable
rather than dropped so v1's historical rows keep their receipts.
`resurfaced_posts` stays dormant alongside `/posts`.

### Security: the tick endpoint was publicly triggerable

`/api/pipeline/tick` and `/api/calendar/tick` were unauthenticated route
handlers — anyone who knew the URL could spin the job queue. Both are gone.
The in-page pollers now call Server Actions (`app/actions/tick.ts`), which
need no publicly documented endpoint and no secret in the browser; the
GitHub Actions schedule calls `/api/jobs/tick`, which was already behind
`CRON_SECRET`, with an `Authorization: Bearer` header.

This means the workflow now needs a `CRON_SECRET` repository secret matching
the Vercel environment variable, alongside the existing `TRELLIS_URL`
repository variable. Without it the workflow logs the omission and exits 0
rather than silently failing.

---

## v2 — Task 1 and the ten views

### The data split

The managed account's own data comes from the Instagram Graph API; Apify is
reduced to competitors and niche discovery. `scanAccount` refuses
`role: 'self'` outright rather than merely not being called that way — the two
paths disagree about what a "view" is, and letting both write the same rows
would produce numbers that silently aren't comparable.

Existing v1-scraped self posts are kept as historical baseline. Graph insights
have a limited lookback and cannot backfill reach or saves for them, so every
analytics view degrades on null rather than dropping the post. `posts.source`
records which pipeline a row came from.

### The rule every view follows

**A number that isn't known renders as a blank, never a zero.** This is the
single most load-bearing decision in v2, because most views are partly null by
nature:

- Meta retires and renames insight metrics between API versions (`impressions`
  became `views`). A version bump silently turning real engagement into zeros
  would be indistinguishable from a post that flopped. So a metric the API
  declines comes back `null` with a reason recorded, and when a batched
  insights request 400s because one name is retired, it retries
  metric-by-metric rather than losing all of them.
- A missing day in the follower series is a gap, not a flat day — the
  day-over-day change is null across it.
- A tag with no prior window has a null share change, not zero: "nothing to
  compare against" is not "no change".
- `sum()` over an all-null column returns null in Postgres but 0 through some
  drivers, which is why the weekly rollup aggregates in JS.

`components/ui/metric.tsx` is the one place a blank is rendered, and
`CoverageNote` says at the top of a table how much of it is measured rather
than leaving the reader to count dashes.

### Statistical guards worth remembering

- **Ideas** divides a post's engagement by its own account's median. Raw likes
  only rank accounts by size. Accounts with fewer than 5 held posts are
  excluded and named — a median over fewer is noise, and dividing by noise
  produces a confident-looking number with nothing behind it. A zero median is
  excluded rather than divided by. The baseline uses the whole held history,
  not the scored window, or a breakout would drag up the very median it is
  measured against.
- **Hot topics** compares share of posts, not raw counts. A window where the
  pool simply posted more would inflate every count and make everything look
  like it was rising.
- **Post tracker** needs a 5% threshold for "climbing". Reach ticks up by a
  handful for weeks on almost every post; `> 0` would label everything.
- **Opportunities** was where a real bug surfaced: the format baseline was the
  median of the format medians, which for two formats just picks the higher
  one — so the better-reaching format could never clear its own bar. It is now
  the median across the account's posts. Caught by a test, not by review.

### Riyadh weeks are not UTC weeks

`lib/time.ts` is a fixed +3 offset (Saudi Arabia has had no DST since 1990) and
is a comparison/presentation layer only — every `timestamptz` stays UTC. The
boundary matters: an entry at 01:00 Riyadh on a Monday is 22:00 UTC on the
Sunday, so a naive `ORDER BY scheduled_for` files it in the wrong week. Both
the calendar grouping and the weekly rollup are tested against exactly that
instant.

`isOverdue` is deliberately not `isDue`: something scheduled for 09:00 that it
is now 14:00 the same Riyadh day is due (act now), not overdue (you missed it).

### Scheduling

Vercel Hobby allows two cron entries, once a day each, and both were already
spoken for by keepalive and publish. The three v2 schedules — daily own-account
sync, weekly niche pass, weekly token refresh — run from GitHub Actions against
`/api/cron/*`, all behind `CRON_SECRET`.

Discovery no longer chains off a scan. In v1 the expensive Apify path fired on
the cheapest trigger; it now runs weekly. Hashtag scans were also spending
unguarded, so discovery could overrun the month's allowance on its own — that
is budgeted now too.

### Not yet exercised against reality

Everything in the Graph API layer is tested against a fake `fetch` mirroring
Meta's documented shapes. No real `IG_ACCESS_TOKEN` with
`instagram_manage_insights` has been used against a live account, so the exact
metric names the current API version serves, the `follows_and_unfollows`
breakdown shape, and whether `shortcode` appears on the media edge are all
unconfirmed. The metric-by-metric retry exists precisely because that first
contact is expected to disagree with the documentation somewhere.

The follower-snapshot actor input (`resultsType: 'followers'`) is likewise
assumed, not verified — the same class of bug as the `usernames`/`username`
drift found in v1.

---

## v2 — Task 3: first contact and verification

### What was actually verified, and what was only prepared

Only some of this could be run without live credentials. Splitting it honestly:

**Verified for real, locally:**

- The full migration, dry-run against a v1-shaped database seeded with awkward
  rows (unicode captions, embedded apostrophes and newlines, a draft whose
  slides were inserted out of order with one unrendered, a non-`slide` asset,
  two never-scheduled drafts, a failed schedule row with attempts). 4 schedule
  rows in, 4 calendar entries out, no field losses, no mismatches.
- The migrated rows read back correctly through the real code paths —
  `listEntries`, `calendarView`, `claimDueForPublish`, `weeklyReport`.
- Cron auth: 20/20 against a running production build. Every `/api/cron/*` and
  `/api/jobs/tick` returns 401 unauthenticated and with a wrong bearer, 200
  with the right one; `/api/pipeline/tick` and `/api/calendar/tick` return 404.
- All 14 routes render with an empty database, each with an honest empty state.
- Tracker, calendar-boundary and unfollows behaviours, against seeded data
  chosen to break them (below).

**Prepared but not run — needs credentials only the account owner has:**
`scripts/probe-graph.ts`, `scripts/probe-apify-followers.ts`, and
`scripts/verify-cron-auth.ts` against the production URL.

### A trap in the dry-run procedure worth recording

Seeding a scratch database by piping `0000_*.sql` through `psql` does **not**
write drizzle's `__drizzle_migrations` bookkeeping, so the next `db:migrate`
tries to replay 0000 and dies on `CREATE TABLE "accounts"`. A restored Supabase
snapshot carries that table with it and is fine; a hand-built scratch database
is not. Apply 0000 through `db:migrate` (with the later migrations temporarily
moved aside) instead.

### `claimDueForPublish` is a write

It was in the first draft of the post-migration read-back check. It moves due
rows to `claimed`. It must never run against production as part of
"verification" — noted here because it reads like a query.

### Bugs found by looking at real rendered pages

- **`/unfollows` showed "Net, last 30 days: 0"** with a single day of history.
  Summing an empty list of known changes gives 0, which reads as "you held
  steady" — a different claim from "we have one reading". Now null.
- **`/audience` claimed a 90-day window it does not have.** `sync_own_account`
  pulls comments for its `commentLimit` most recent posts (10 by default), so
  actual coverage is "your last 10 posts", which for an active account is far
  short of 90 days. The ranking window was never wrong; the label was. The page
  now states the real span held and says explicitly that someone who commented
  before it is missing because they were never fetched, not because they went
  quiet.
- **Raw `sql` aggregates come back as strings.** `min()`/`max()` in a raw
  template have no column type for postgres-js to parse against, so
  `oldestComment` arrived as a string and `.getTime()` threw. Same root cause as
  the earlier `Date`-binding fix in `audienceSummary`. Coerced at the boundary.

### Verified behaviours, with the data that would have caught a fake

- **Tracker does not invent curves.** A 200-day-old post with no insights
  renders every checkpoint as `—` and status `not measured`; a 3-hour-old post
  renders `—` and `too new`; only the genuinely tracked post shows a curve
  (1.0K → 1.5K → 3.0K, now 3.2K, `climbing`). Three different kinds of blank,
  each labelled as what it is.
- **The Riyadh boundary holds end to end.** An entry stored as
  `2026-08-16T22:00:00Z` renders as `Mon 17 Aug, 01:00` and files into the week
  beginning Monday 17 Aug — not the Sunday-16th week a UTC grouping would pick.
- **`/unfollows` with one day** shows the count, `—` for change, and the real
  Meta reason string for the missing follows/unfollows breakdown.

### `/opportunities` and `/weekly` are not LLM-generated and not cached

Worth stating plainly because it was assumed otherwise. Neither page makes a
model call; both are pure SQL over stored rows, recomputed per request at
10–27 ms locally. There is no regeneration-on-reload risk because there is no
generation at all.

The only model output anywhere in that chain is the _phrasing_ of pattern
claims, produced once inside `run_analysis` on the weekly cron and stored in
`analyses.patterns` — already generate-once-read-many, and with a validated
deterministic fallback if the model is unavailable.

Known scaling boundary rather than a problem today: `ideas()` and `hotTopics()`
load the whole competitor post set into memory to compute per-account
baselines. Fine at the current ~132 posts; would want a SQL rewrite well before
10k.

---

## v2 — Correction: Opportunities and Weekly are generated, not computed

### What was wrong

Spec 2.8 said Gemini analyses the Post Analytics dataset weekly and returns
findings citing the posts they came from. It was built as pure SQL. 2.9 wanted
the same for the weekly narrative.

The likely cause: ruling #2 said to reuse the `analyses` table for
Opportunities and keep writing `patterns`. That table _was_ v1's deterministic
pattern pipeline, so reusing it pulled the computation model along with the
storage. The ruling was about where output lives, not how it is produced.

Recorded because the earlier report identified the discrepancy and filed it as
a correction to the brief rather than as a deviation from it. Finding that the
code disagrees with the spec is not, by itself, evidence that the spec is wrong.

### The architecture

**SQL computes, Gemini interprets, code validates, the result is cached.**

None of the SQL was deleted. It stopped being the output and became the input:
`lib/generate/payload.ts` reuses the analytics queries wholesale, and every
number that reaches the model was produced by a query.

Gemini never computes a statistic. Models are fluent at arithmetic-shaped prose
and will produce a plausible median that is simply wrong — the exact class of
quiet fabrication the rest of this codebase avoids.

### The validator is the guarantee, not the prompt

`lib/generate/validate.ts` extracts every number reachable in the payload,
plus the roundings a model legitimately produces from them (3241.5 → "3,241",
"3242"; 0.0412 → "4.1%", "4%"), and drops any insight asserting a figure
outside that set. Citations are checked the same way: an insight naming a post
id absent from the payload is unfalsifiable and does not render.

The prompt asks for the same discipline. Both, deliberately — the instruction
improves the hit rate, the code makes the guarantee. Relying on the prompt
alone is a request, not a constraint.

The strictest case, and the one the tests pin: `5120 - 900 = 4220` is
arithmetically correct and still rejected, because SQL never computed it and
nothing on the page could be traced back to a query.

Dropping rather than caveating is also deliberate. A wrong number with a hedge
attached is still a wrong number on screen, and the reader cannot tell which
half to trust.

### Sample floors run before the call

A format below `MIN_FORMAT_SAMPLE` never enters the payload; an account below
`MIN_MEASURED_POSTS` measured posts skips the call entirely. A model cannot
caveat its way around thin data it was never given, and asking it to notice
thin data is asking it to be reliable about the thing it is worst at.

### Caching

Generation runs on the weekly cron and writes to `generations`, keyed by
Riyadh week. Page loads read cache and never generate — verified: three
reloads of `/opportunities` produced zero additional `generate_*` runs.

Manual regeneration is capped at 5/day per kind, counted against the `runs`
ledger rather than stored rows, so a loop of failures still counts. Verified:
attempts 1–5 return 200, attempt 6 returns 429.

`payload` is stored next to `output` on purpose. It is the evidence the
generation was validated against; without it a stored insight can never be
re-checked.

### Fallback

A model failure, a quota exhaustion, or a wholly-invalidated response falls
back to the deterministic output, labelled **unelaborated** in the UI. Never a
blank page, never a fabricated one. The figures underneath are always the
computed ones and are unaffected by whether generation ran.

### Hot Topics took the same path — still outstanding

Confirmed by inspection: zero LLM calls across all eight modules in
`lib/analytics/`, `topics.ts` included. It is a deterministic hashtag-share
comparison.

That is a wider gap than Opportunities was, because 2.7 asked for generated
_concepts_ split by platform — invented territory to explore — and what exists
measures hashtags that already appeared. The computation model and the subject
matter both differ, so it is not a matter of wrapping the existing query in a
generation call. Not fixed here; it needs its own pass against the 2.7 text.

---

## v2 — Post analytics, tracker, followers and unfollows fold into the Dashboard

Four tabs became four sections of one page. They were four views of a single
question — how is this account doing — and splitting them meant answering it
took four clicks plus a memory of which tab held which number.

What stays a tab is either about _other_ accounts (Ideas, Hot topics,
Competitors) or about doing rather than reading (Calendar, Chat). Nav goes 13 → 9.

`/analytics` survives off-nav, linked from the Dashboard section that
summarises it: 100+ post rows want a page of their own. `/tracker`,
`/audience` and `/unfollows` are deleted — their content fits inline.

The dashboard's queries run in one `Promise.all` rather than serially, since
there are now ten of them.

### Two bugs the consolidation surfaced

**`mostActiveFollowers` returned strings where the type said `Date`.** Its
`min()`/`max()` aggregates are raw `sql` templates with no column type for
postgres-js to parse against — the same root cause as the `audienceSummary`
fix, in the sibling function, missed at the time. Handing one to
`Intl.DateTimeFormat` throws `RangeError: Invalid time value`, so the page 500d
as soon as it rendered with commenter data. `/audience` had the same latent
bug and never hit it, because it was only ever rendered against an empty
database. The test now asserts `instanceOf Date` rather than checking values,
which is what would have caught it.

**`byFormat` reported a total where the median had a much smaller sample.**
"image · 17 posts · median eng 36.7%" was computed from the one image that
carried reach; the other sixteen predate the Graph connection. The count a
reader takes as the median's evidence was seventeen times the real one.
`FormatBreakdown` now carries `measuredCount` and the table renders
"17 (2 measured)". Early on, when almost nothing is measured, this is the
difference between a baseline and a coincidence.

### A debugging note worth keeping

`pkill -f "next start"` does not kill the server — the process is
`next-server`, so the old build keeps serving and every "fix" appears not to
work. `fuser -k 3000/tcp` is the one that works. Two rounds were lost to
testing stale code before the `EADDRINUSE` in the log gave it away.

---

## v2 — cutover sequencing, and a scope that was missing

Three corrections to the migration plan, all of them right, recorded because
two were sequencing mistakes rather than code mistakes and would not otherwise
leave a trace.

### `instagram_content_publish` was missing from the scope check

`REQUIRED_SCOPES` listed the five scopes the _reads_ need and omitted the one
the publisher runs on. Since the publish pipeline was deliberately retained,
regenerating a token from that list would have quietly broken publishing — and
`/settings` would never have said so, because it only checked the five.

Now split: `REQUIRED_SCOPES` (five, always) and `PUBLISHING_SCOPES` (one,
reported separately — quietly while `ENABLE_IG_PUBLISHING` is off, loudly once
it is on). Keeping them separate means an account that posts by hand isn't
nagged about a scope it will never use, while still being told the token is
one scope short of being able to publish. `probe:graph` checks all six.

### Probe before migrating, not after

The original plan was token → migrate → probe. `probe:graph` is local and
read-only: it touches no database and no deployment. If it comes back showing
metric names differ, or that reels and images serve different fields, the
mappers change and possibly the schema with them — so migrating first means
migrating twice. Reversed.

### The migration is not "safe with a backup", because `main` is still v1

This was the sharpest of the three and the one most easily missed. `main`
still runs v1, which reads `drafts` and `schedule` in eight files. The moment
`0002` drops those tables the deployed app is querying tables that do not
exist. The same applies to the environment variables: v1's slide rendering
reads `IMAGE_PROVIDER` and `SUPABASE_STORAGE_BUCKET`, so deleting them while
v1 is live breaks it.

Migration, merge, deploy and env changes are therefore one window, not four
tasks. A backup makes the _data_ recoverable; it does nothing about the app
being broken in between.

`docs/cutover.md` now carries the ordering, split explicitly into "free and
reversible" and "the cutover window", so the distinction survives outside a
conversation.

### Thresholds are seed-tuned and should be revisited

Every threshold in the analytics layer was chosen against seeded data. They
are listed in `docs/cutover.md` with their current values so they can be
questioned once a month of real history exists — the "climbing" threshold, the
viral-score floor, the topic noise floor, the opportunity sample floors, and
the comment window in particular.

The dashboard consolidation belongs on that list too: `/tracker`, `/audience`
and `/unfollows` were folded in as sections rather than kept as tabs, and if
any of them turns out to need more room than a section gives it, bringing it
back is a small change.

---

## v2 — first live Graph API contact: a seventh scope, and a version being upgraded underneath us

### `business_management` is required, and its absence is silent

With six scopes, `GET /me/accounts` returned `{"data": []}` while
`GET /me?fields=id,name` returned the correct profile. The token was valid and
belonged to the right user; the Page list was simply empty. Nothing errored.
Adding `business_management` and regenerating returned the Page.

That failure mode is the finding. A missing permission presenting as an empty
collection rather than an error is the same class as every other quiet-zero
problem this build guards against — an empty array looks like an answer.

Now in `REQUIRED_SCOPES`. Two nuances worth recording:

- The app **never calls `/me/accounts`** — it reads a configured `IG_USER_ID`.
  So the scope is proven necessary for _discovering_ the Page during setup and
  unproven for the ongoing reads. It goes in `REQUIRED_SCOPES` anyway: the cost
  of requiring a scope you did not need is nothing, the cost of a regenerated
  token missing it is a setup you cannot repeat.
- `granular_scopes` showed `pages_show_list` and `pages_read_engagement`
  targeted at the Page id, and `business_management` with no target, on an
  account holding four business portfolios none of which was connected to the
  app. Whether the requirement is universal or an artefact of portfolio
  ownership is open, and it matters at multi-tenancy.

### The API version the app asks for is not the one it gets

Requests to `v21.0` came back with `v26.0` in every response URL. Meta
upgrades calls to a retired version without saying so — which is precisely how
a renamed metric (`impressions` → `views`, `plays` folded into it) turns real
engagement into nulls with nothing noticing, since the per-metric retry path
cannot fire on a rename it does not know happened.

The version is now one env-driven constant (`GRAPH_API_VERSION`) behind
`call()`, so reads and writes cannot drift apart, and `/settings` prints what
is being requested so it can be compared against a probe response.
`scripts/probe-graph.ts` reads the same variable but keeps its own default: a
probe that imports the app's constants can only ever confirm them.

### What the probe got wrong, and why that is worse than a missed finding

It marked `thumbnail_url` ABSENT off `rows[0]`, a carousel. A reel in the same
response carried it. The real rule is type-conditional — served for
`VIDEO`/`REELS`, omitted for `CAROUSEL_ALBUM`/`IMAGE`, which carry `media_url`.

The mapper was already right (`thumbnail_url ?? media_url ?? null`). The probe
was not. It now samples one item per media type before reaching a verdict, and
reports "type-conditional: on X; not on Y" as its own outcome — plus an
explicit finding naming the media types absent from the page entirely, so
UNPROBED is never mistaken for clean. A probe that cries wolf gets discounted,
and then the next real finding gets waved through with it.

### What did not go wrong

Reel and carousel both return all seven media metrics with identical shapes and
`period: lifetime`. The batched request succeeds for both and **the per-metric
retry path never fired**. Format-divergence was the risk the whole retry
mechanism was built around; it is not real at this version. The path stays as
insurance against future drift — but as insurance, stated, rather than as an
open worry.

`shortcode` is present, so the join back to the v1-scraped `posts` rows holds.
Worth remembering that `lib/insights/graph.ts` **drops a media item entirely**
when shortcode resolves to null, so a type that omits it would lose posts
rather than store them incomplete. No image posts exist on the account, so that
type is unprobed.

### A post five months old returned full lifetime insights

`docs/roadmap.md` at `c131042` stated flatly that Graph insights do not
backfill and that v1-scraped posts never would have reach data. A post dated
`2026-03-29` returned reach 128, views 144, saved 1. The claim is withdrawn;
where the lookback actually ends is now the highest-value open question in the
project, because it decides whether the chat reasons from twenty posts or two.
