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
  The same is true of `getChatModel()` (Stage 7) — the streaming chat
  route was smoke-tested end-to-end with no key configured, confirming
  the quota gate and error path, but no real Gemini response has been
  streamed through it yet.
