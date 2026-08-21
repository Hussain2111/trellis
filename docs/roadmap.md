# Trellis — state of the app, and the road to finished

Last updated at commit `a38bcc6` on `claude/trellis-v1-growy-parity-n509nm`.

This document is about the **app as an operated system** — the Vercel project,
the Supabase database, the GitHub repository and its Actions, the Meta app and
its token, the Apify account and its credit — not about the source code. Code
history lives in `NOTES.md`. The mechanical cutover checklist lives in
`docs/cutover.md`. This is the thing that sits above both: where the project
has been, what it cost, what is broken, and what is left.

---

## 0. Where we are right now, in one paragraph

There are **two Trellises**. The one that is _deployed_ — on `main`, live on
Vercel, connected to a real Supabase database — is **v1**: a generative
product that scrapes competitors, finds a gap, writes you twelve drafts a week
and renders slides. The one that is _built_ — sixteen commits on a branch,
246 tests green, never deployed anywhere — is **v2**: a measurement product
that reads your own account through the Instagram Graph API and tells you what
is actually happening. Nothing about v2 has ever touched a real Instagram
token, a real Apify follower run, or the production database. The gap between
"built" and "working" is not code; it is roughly two hours of credential work,
one irreversible database migration, and a deploy window. **That window has
not been opened yet, and everything downstream of it is blocked on it.**

---

## 1. How to read this

Stages run in order and gate each other. Inside a stage, **tasks** are units of
work you could stop after; **steps** are the actual clicks and commands.
Every task carries:

- **Resources** — the specific dashboard page, doc, script or file involved.
- **Notes** — what it is, how it is done, and why it is done that way.
- **Blockers** — anything that stopped it, or will stop it.

Stages 0–9 are history. Stage 10 is where you are standing. Stages 10–15 are
the road out.

---

# PART I — THE ROADMAP SO FAR

## Stage 0 — Inheritance and the infrastructure decision

**Status: done. This stage decided the cost model of everything after it.**

### Task 0.1 — Assess what was inherited

The repository started as a complete, working build of a _different_ product:
single-user, single-machine, SQLite on disk, Ollama running a local model, a
persistent worker process, and a `cloudflared` tunnel so Meta could reach a
laptop to fetch images.

- **Resources:** `legacy/` (the entire old build, moved with `git mv`, never
  deleted), `NOTES.md` § "Migration from the local-first build".
- **Notes:** none of that survives a serverless host. There is no Ollama on a
  Vercel function, no persistent process to run a drain loop in, no local disk
  to keep a SQLite file on. This was a foundation rewrite, not a refactor.
  Keeping the old tree readable rather than deleting it was the right call and
  paid off repeatedly — prompts, formulas and UI patterns were read back out
  of it at every later stage.
- **Blockers:** none.

### Task 0.2 — Choose the hosting stack, and the budget

- **Steps:** Vercel (Hobby) for hosting → Supabase (Free) for Postgres →
  Google AI Studio (free tier) for Gemini → Apify (free monthly credit) for
  scraping. Target: **$0/month**.
- **Resources:** [vercel.com/pricing](https://vercel.com/pricing),
  [supabase.com/pricing](https://supabase.com/pricing),
  [aistudio.google.com/apikey](https://aistudio.google.com/apikey),
  [console.apify.com/billing](https://console.apify.com/billing).
- **Notes:** the $0 target is not a footnote — it is the single most
  consequential decision in the project, and it is the direct cause of at
  least four later problems (cron cadence, the 11-hour stall, the follower
  snapshot's cost ceiling, the absence of automated database backups). It was
  still the right decision for a personal tool; it just needs to be understood
  as a decision with a bill attached, paid in operational complexity instead
  of money.
- **Blockers (structural, permanent, still in force):**
  - **Vercel Hobby cron is capped at 2 entries running once per day each.**
    Not "2 per day per entry" — once a day, full stop. Both slots are already
    spent (`keepalive`, `publish`).
  - **Supabase Free pauses a project after ~7 days of no activity**, which is
    why a keepalive cron exists at all and why it performs a real write rather
    than a ping.
  - **Supabase Free has no automated backups.** This matters enormously at
    Stage 11 and is dealt with there.

### Task 0.3 — GitHub repository and CI

- **Steps:** repo created → `.github/workflows/ci.yml` → CI runs typecheck,
  lint, format check, `db:migrate` and the full test suite against a **real
  Postgres 16 service container**, then `next build`.
- **Resources:** `.github/workflows/ci.yml`, GitHub → Actions tab.
- **Notes:** running migrations and tests against a real Postgres in CI rather
  than a mock is the reason several genuine driver-level bugs were caught
  before they ever reached Supabase. Cheap, and it earned its keep.
- **Blockers:** none.

---

## Stage 1 — The cloud skeleton

**Status: done and verified.**

### Task 1.1 — Supabase project and the connection string

- **Steps:** create project → copy the **connection pooler** URL (transaction
  mode, port 6543) → set `DATABASE_URL` locally and in Vercel.
- **Resources:** Supabase → Project Settings → Database → Connection string →
  _Connection pooling_; `lib/db/client.ts`; `.env.example`.
- **Notes:** the pooler, not the direct connection. Vercel functions are
  short-lived and can run many at once; a direct connection's limit cannot
  absorb that. Transaction-mode pooling also requires prepared statements to
  be disabled, which the client does.
- **Blockers, hit for real:** the direct database hostname resolves to IPv6
  only on newer Supabase projects, and not every client environment can reach
  it. The pooler hostname is the one that works. If a connection ever "hangs
  with no error", this is the first thing to check.

### Task 1.2 — Schema and migrations

- **Steps:** Drizzle schema → `npm run db:generate` → `npm run db:migrate`.
- **Resources:** `drizzle/`, `scripts/migrate.ts`, `npm run db:studio`.
- **Notes:** migrations are applied by a script, not by hand in the Supabase
  SQL editor. This is load-bearing — see Stage 11, Task 11.2. Drizzle runs
  every pending migration inside **one transaction**; the Supabase SQL editor
  autocommits each statement.
- **Blockers:** none at this stage.

### Task 1.3 — The job queue and the keepalive cron

- **Steps:** jobs table with `FOR UPDATE SKIP LOCKED` claiming → time-boxed
  `runTick()` → `/api/cron/keepalive` → `vercel.json` cron entry →
  `CRON_SECRET`.
- **Resources:** `vercel.json`, Vercel → Settings → Cron Jobs,
  Vercel → Settings → Environment Variables.
- **Notes:** the app has **no user authentication of any kind** by design —
  it is a single-user tool at an obscure URL. `CRON_SECRET` is therefore the
  only thing standing between a queue-advancing endpoint and the open
  internet. Vercel sends it automatically as a bearer token on its own cron
  invocations when the variable is set on the project.
- **Blockers:** none.

---

## Stage 2 — Scraping (Apify), fire-and-webhook

**Status: done, and later found broken against reality — see Stage 7.**

### Task 2.1 — Apify account, token, actor

- **Steps:** create account → copy API token → pick
  `apify/instagram-profile-scraper` → set `APIFY_TOKEN`, `APIFY_ACTOR`.
- **Resources:** [console.apify.com](https://console.apify.com) → Settings →
  Integrations → API tokens; the actor's Store page → **Input** tab.
- **Notes:** the actor's Input tab is the authoritative schema. It was not
  read carefully enough at this stage, and that cost a live deploy cycle later.
- **Blockers:** Apify's free credit is a hard monthly ceiling, so the app
  tracks estimated spend in a `runs` ledger and refuses to start a scan that
  would overrun it.

### Task 2.2 — The async completion problem

- **Steps:** fire the actor and return immediately → mark the job `waiting`
  with the run id in its checkpoint → Apify calls `/api/webhooks/apify` on
  completion → the webhook finds the waiting job and finishes it.
- **Resources:** Apify → Actor run → Webhooks; `APIFY_WEBHOOK_SECRET`.
- **Notes:** a blocking `.call()` would exceed a Vercel function's wall-clock
  ceiling on any real scrape. Fire-and-webhook is the only shape that fits a
  serverless host, and it became the template for every long external wait in
  the app.
- **Blockers:** an inbound webhook requires the deployment to be publicly
  reachable. It was not. See Stage 7.

---

## Stage 3 — Discovery, Stage 4 — Analysis, Stage 5 — Generation

**Status: built, tested, deployed as v1. Largely deleted by the v2 pivot.**

Compressed deliberately: these stages are where most of the _code_ went and
almost none of the _operational_ difficulty. They are also, as of v2, mostly
gone.

| Stage | What it added                                                                          | Fate in v2                                                      |
| ----- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 3     | Hashtag-based competitor discovery, niche inference (one Gemini call)                  | **Kept**, moved from "fires on every scan" to a weekly schedule |
| 4     | The analysis engine: features → hook classification → 5 ranked patterns, with receipts | **Kept** as the competitor/niche half                           |
| 5     | Voice profile + 12 drafts/week                                                         | **Deleted**                                                     |
| 6     | Slide rendering (satori + resvg) + Supabase Storage                                    | **Deleted**                                                     |
| 7     | Streaming chat coach with 7 read-only tools                                            | **Kept**                                                        |
| 8     | Scheduling + Graph API publishing                                                      | **Kept**, off by default                                        |

- **Resources:** `NOTES.md` §§ Stage 3–8 for the full record.
- **Operational notes worth carrying forward:**
  - Gemini free-tier quota is rationed per job type through a ledger, so a
    chat binge cannot starve the weekly analysis. That mechanism survives v2
    and is what keeps the model bill at zero.
  - Supabase Storage was set up in Stage 6 and is **abandoned** in v2. Its
    bucket and its two service-role keys are on the delete list at Stage 11.
  - Publishing was deliberately built and left **off** (`ENABLE_IG_PUBLISHING=false`).
    That flag is still off and should stay off until the account owner has
    watched one post go out by hand.

---

## Stage 6 — Surfacing: the UI

**Status: done.** Every stage above had shipped backend machinery with no page
to look at. This stage built the pages. Operationally uninteresting except for
one discovery that mattered a great deal later:

> `/settings` renders the _resolved_ environment values the running function
> actually sees. It turned out to be a **more reliable way to confirm a Vercel
> environment variable change had taken effect than the Vercel dashboard
> itself.** Keep using it that way.

---

## Stage 7 — First contact with real infrastructure

**Status: done. This is the ugly stage, and the most valuable one.**

The app was deployed to a real Vercel project against a real Supabase database
for the first time. Everything that had passed locally and in CI continued to
pass. Four things broke anyway, and **none of them were code logic** — all four
were the shape of a real external system.

### Blocker 7.1 — The Apify actor input field name

Every live run failed with `Input is not valid: Field input.usernames is
required`. The code sent `username`; the actor wanted `usernames`.

- **Why no test caught it:** every scan test runs against a fixture or fake
  scraper, which never constructs a real actor input payload. This class of
  bug is only reachable by a live run.
- **Fix:** rename the field.
- **Still outstanding, same class:** the **hashtag** actor's input shape has
  never been confirmed against a real run, and the **follower** actor's input
  (`resultsType: 'followers'`) is a pure assumption. Two more of these are
  almost certainly waiting.

### Blocker 7.2 — Vercel Deployment Protection blocked the webhook

With the input fixed, the scrape succeeded and the completion webhook failed
with `401 Protected deployment`. Vercel Authentication was on, gating every
deployment behind Vercel's own SSO — which an external service can obviously
never satisfy.

- **Resource:** Vercel → Settings → **Deployment Protection** → Vercel
  Authentication.
- **Notes:** must be off, or scoped to Preview deployments only. Any inbound
  webhook or external scheduler hits this. It is a project setting, invisible
  from the code, and it will silently come back if the project is ever
  recreated from a template.

### Blocker 7.3 — Vercel environment variable footguns

Two, both costing real deploy cycles:

1. **A variable marked "Sensitive" becomes write-only.** Its value can never
   be read back, only overwritten — which makes a failed save indistinguishable
   from a successful one. Do not mark things Sensitive unless there is a
   reason; every value here is already a secret in a private project.
2. **A variable saved without every target environment ticked** (Production /
   Preview / Development) silently does not apply where you assume it does.

### Blocker 7.4 — The queue had no engine

The single most important discovery of the stage. A scan enqueues a chain
behind itself. In production, **nothing was advancing that chain.** `/api/scan`
only ticks the one job type it just created; the webhook only finishes the one
job it was called about; Vercel Hobby cron runs once a day. Every job after the
first sat `pending` forever.

- **Invisible locally** because every manual `runTick()` during development
  advanced the whole chain artificially.
- **First fix:** a client-side poller on the dashboard hitting an
  unauthenticated `/api/pipeline/tick` every 10 seconds — the pipeline
  finishes while you watch it, instead of "sometime tomorrow".
- **That was not enough.** A scan left overnight with no browser tab open
  **stalled for 11 hours** on jobs that involve zero network calls and should
  take milliseconds. The poller only runs while a tab is open.
- **Real fix:** `.github/workflows/pipeline-tick.yml` — GitHub Actions cron
  every 10 minutes, hitting the same endpoint. GitHub's scheduler is not
  subject to Vercel's cap. **This is the pattern that saved the whole
  scheduling model**, and v2's three schedules live there for the same reason.
- **Requires:** GitHub → Settings → Secrets and variables → Actions →
  **Variables** → `TRELLIS_URL`, pointing at the **stable production domain**,
  not a per-deployment URL (those change on every deploy and would break this
  silently).

---

## Stage 8 — The v2 pivot

**Status: built. Not deployed. Sixteen commits on a branch.**

The product changed from "write me content" to "tell me what is happening".

| Task              | What it did                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task 0**        | Removed the generative half; migrated `drafts` + `schedule` → `calendar_entries` (migrations `0001`–`0002`)                                  |
| **Task 1**        | Added the Instagram Graph API data layer: post insights, comments, follower history (migration `0003`); restricted Apify to competitors only |
| **2.1–2.5**       | Post analytics, post tracker, Riyadh-week calendar, most-active followers, unfollows                                                         |
| **2.6–2.10**      | Ideas, hot topics, opportunities, weekly rollup, competitors                                                                                 |
| **Correction**    | Opportunities and Weekly rebuilt as _SQL computes → Gemini interprets → code validates → cached_ (migration `0004`)                          |
| **Consolidation** | Post analytics, tracker, followers and unfollows folded into the Dashboard; nav cut from 13 items to 9                                       |

### Operational consequences of the pivot

- **The data source flipped.** v1 read Instagram through a scraper. v2 reads
  the managed account through Meta's own API. That means a **token with six
  scopes**, and it means the account must be a Business/Creator account linked
  to a Facebook Page.
- **Scraping shrank to competitors only.** Apify still runs, but weekly and
  only against other people's accounts. Cheaper and less fragile.
- **Three new schedules** that Vercel cannot host (both cron slots spent), so
  they live in `.github/workflows/scheduled-jobs.yml`: a daily own-account
  sync at 23:00 UTC (02:00 Riyadh) and a weekly niche + token pass at 00:00
  UTC Monday.
- **Five environment variables become dead** (`IMAGE_PROVIDER`,
  `GOOGLE_MODEL_LITE`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_STORAGE_BUCKET`) and one becomes newly required in production
  (`CRON_SECRET`, also as a GitHub Actions secret).

### The governing product rule, worth stating because it drives every blank cell you will see

> **A number that is not known renders blank, never zero.** A believable wrong
> number is worse than no number.

This is why the dashboard will look sparse on day one and why that is correct
rather than broken.

---

## Stage 9 — Verification (v2 Task 3)

**Status: half done. The half that needed no credentials passed. The half that
needs your account has never been run.**

### Verified for real, locally

- The full `drafts` + `schedule` → `calendar_entries` migration, dry-run
  against a v1-shaped database deliberately seeded with awkward rows — unicode
  captions, embedded apostrophes and newlines, out-of-order slides, an
  unrendered asset, never-scheduled drafts, a failed row with attempts. Four
  rows in, four out, no field losses.
- Cron authentication: **20/20** against a real production build. Every
  `/api/cron/*` and `/api/jobs/tick` returns 401 without a token and with a
  wrong one, 200 with the right one; the two unauthenticated tick routes v1
  used are now 404.
- All 14 routes render against an empty database with an honest empty state.
- Three real bugs found by _looking at rendered pages_, not by tests: a
  fabricated "net change: 0" from a single day of history, a page claiming a
  90-day comment window it does not have, and a date-parsing crash that would
  have 500'd the dashboard the moment real comment data existed.

### Prepared but never run — blocked on credentials only you have

- `npm run probe:graph` — read-only, local, free, per-metric.
- `npm run probe:apify-followers` — one small run, costs cents.
- `npm run verify:cron-auth <production-url>` — against the live deployment.

---

# PART II — THE GOOD, THE BAD, AND THE DOWNRIGHT UGLY

## The good

- **The $0 target held.** No paid provider has ever been instantiated; a guard
  throws at startup if one is, naming it. `/settings` shows the running total.
- **The honesty discipline is real and it has teeth.** Blank-not-zero is
  enforced at the query layer, and the Gemini interpretation layer validates
  that **every number in the model's output appears verbatim in the
  SQL-computed input** — in code, not as a polite instruction in a prompt. An
  insight citing a figure nobody computed is dropped, not shown.
- **The GitHub Actions escape hatch.** Discovering that an external scheduler
  sidesteps Vercel's cron cap turned a hard platform ceiling into a
  non-problem, for free.
- **Migrations are reconcilable.** The one irreversible step in the project
  has a two-pass verification script that names any row that fails to carry
  over, and a guard inside the migration itself that aborts the drop if the
  backfill came up short.
- **CI runs against a real Postgres**, which caught driver-level bugs no mock
  would have.
- **246 tests, green.** Lint, typecheck and build clean.

## The bad

- **Two Trellises, one database.** The deployed app and the built app disagree
  about the schema. This is a perfectly normal branch state, but it means the
  migration cannot be run early "to get it out of the way" — it would break
  production instantly. Everything is bottlenecked on one window.
- **The Graph API layer has never met the Graph API.** It was written from
  Meta's documentation and tested against a fake `fetch`. Metric names differ
  by media type and by API version. Expect it to be wrong somewhere; the
  per-metric retry exists because of that expectation.
- **The follower actor is almost certainly the wrong actor.**
  `APIFY_FOLLOWERS_ACTOR` currently defaults to the _profile_ scraper, and
  `resultsType: 'followers'` is an assumption of exactly the same class as the
  `username`/`usernames` bug that broke v1 in production.
- **Cost is guessed, not measured.** The per-1000-items rate used for
  budgeting is an assumption. Whether named unfollows is affordable at all is
  undecided until one small probe run answers it.
- **Every analytics threshold is seed-tuned.** "Climbing", the viral-score
  floor, the topic noise floor, the opportunity sample floors — all chosen
  against invented data. They are listed with their current values in
  `docs/cutover.md` so they can be argued with once real history exists.
- **No automated backups.** Supabase Free does not provide them. The one
  irreversible operation in the project therefore depends on you remembering
  to take a manual dump.

## The downright ugly

- **The 11-hour stall.** A scan left running overnight sat frozen on
  millisecond-long jobs because the only thing advancing the queue was a
  browser tab. It looked exactly like a broken app, and it was a platform
  limit meeting a design that assumed something would poll. Fixed — but this
  is the failure mode to fear, and it is why the GitHub Actions ticker is not
  optional infrastructure.
- **A ruling that quietly overrode the spec.** A direction to reuse the
  `analyses` table for Opportunities was about _where output lives_. It was
  applied as _how output is produced_ — dragging v1's deterministic pipeline
  along with the storage — and two specified Gemini features shipped as pure
  SQL. Worse, when the discrepancy was noticed it was written up as a
  correction to the brief rather than a deviation from it. **Finding that the
  code disagrees with the spec is not evidence that the spec is wrong.** Both
  features have been rebuilt correctly. The sibling feature was never checked
  at the same time, which is why:
- **Hot Topics is still wrong, and knowingly so.** Spec 2.7 asked for
  _generated concepts split by platform_ — invented territory to explore. What
  exists measures hashtags that already appeared. The computation model and
  the subject matter both differ, so it is not a matter of wrapping the query
  in a generation call. It needs its own pass against the 2.7 text. **This is
  the only feature currently shipping something other than what was asked for.**
- **A database password was pasted in plaintext into a chat transcript.** It
  should be rotated. It is a two-minute job and it is on the checklist.

---

# PART III — THE ROAD AHEAD

## Stage 10 — Pre-cutover ← **YOU ARE HERE**

**Everything in this stage is free, local, read-only and reversible. None of
it touches production. Do all of it before opening the cutover window.**

### Task 10.1 — Regenerate the Instagram token with all six scopes

- **Steps:**
  1. Confirm the Instagram account is a **Business or Creator** account and is
     linked to a Facebook Page. Personal accounts cannot use insights.
  2. Go to the Meta app → Graph API Explorer. Request **all six** scopes in
     one go:
     `instagram_basic`, `instagram_manage_insights`,
     `instagram_manage_comments`, `instagram_content_publish`,
     `pages_read_engagement`, `pages_show_list`.
  3. Exchange the short-lived token for a **long-lived** one (~60 days).
  4. Paste it into your **local `.env`** — _not_ Vercel yet. Nothing but the
     probes reads it there.
- **Resources:**
  [Graph API Explorer](https://developers.facebook.com/tools/explorer/),
  [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/),
  `docs/instagram-setup.md`.
- **Notes:** `instagram_content_publish` is requested even though publishing
  is off. It costs nothing to hold, and the alternative is discovering it is
  missing on the day you first try to publish. `/settings` reports it
  separately — quietly while publishing is disabled, loudly once it is on.
- **Why local first:** putting a v2-shaped token into Vercel while v1 is live
  changes nothing useful and risks confusing a later debugging session.

### Task 10.2 — Probe the Graph API

- **Steps:** `npm run probe:graph -- --json graph-probe.json`
- **Resources:** `scripts/probe-graph.ts`; Meta's Instagram Insights metric
  reference for the API version in use.
- **Notes:** read-only, local, free, and deliberately written to import
  **nothing** from the app's own Graph code — a probe that shares the code
  under test can only confirm its own assumptions. It requests each metric
  individually, and it probes a reel, a carousel and an image separately,
  because metric availability differs by media type. It also checks all six
  scopes on the token.
- **What to do with the output:** keep the **terminal reconciliation table**.
  The JSON file contains your real account data and is gitignored for that
  reason — do not commit it and do not paste it anywhere.
- **Expected outcome: it disagrees with the documentation somewhere.** That is
  the point of running it.

### Task 10.3 — Choose and probe the follower actor

- **Steps:**
  1. In the Apify console, actually pick a followers actor and **read its
     Input tab**. Confirm the field names it declares.
  2. `npm run probe:apify-followers -- <yourhandle> 20`
- **Resources:** [Apify Store](https://console.apify.com/store),
  `scripts/probe-apify-followers.ts`, Apify → Billing → Usage.
- **Notes:** this is the single cheapest way to avoid repeating the exact bug
  that broke v1 in production. The probe pulls a small page, reports the
  **real** per-1000-item cost, and projects what a full snapshot of your
  follower count would cost.
- **This task decides a feature.** If the projected cost of a full snapshot is
  more than a fraction of the monthly Apify allowance, named unfollows is not
  affordable and should be cut or degraded to counts-only. Do not decide that
  in advance; let the number decide.

### Task 10.4 — Fix the mappers against what came back

- **Steps:** adjust the Graph mappers, the test fixtures, and the follower
  actor input **together**.
- **Notes:** a fixture that mirrors a wrong assumption is worse than no
  fixture — it manufactures confidence. When reality disagrees, the code and
  the fixture change in the same commit.
- **Blocker:** this task cannot start until 10.2 and 10.3 have produced
  output.

### Task 10.5 — Rotate the Supabase database password

- **Steps:** Supabase → Project Settings → Database → Reset database password
  → update `DATABASE_URL` locally and in Vercel (all three environments).
- **Notes:** it was exposed in plaintext. Do it in this stage rather than
  during the cutover window, so a bad connection string is debugged with a
  working app rather than a half-migrated one.

---

## Stage 11 — The cutover window

**One sitting. Not a Tuesday task and a Thursday task.**

The reason is not caution for its own sake: `main` still runs v1, and v1 reads
`drafts` and `schedule` in eight files. The moment migration `0002` drops those
tables, the deployed app is querying tables that do not exist. The same applies
to the environment variables — v1's slide rendering reads `IMAGE_PROVIDER` and
`SUPABASE_STORAGE_BUCKET`, so deleting them while v1 is live breaks it.

**A backup makes the data recoverable. It does nothing about the app being
broken in between.** It is a personal app, so a few minutes of downtime costs
nothing — but it has to be a few minutes.

### Task 11.1 — Back up Supabase

- **Steps:** take a full dump before anything else.
  - Supabase Free has **no automated backups**. Use the Supabase CLI
    (`supabase db dump`) or `pg_dump` against the pooler connection string.
  - Verify the dump is non-empty and contains `drafts` and `schedule` rows
    before proceeding.
- **Resources:** Supabase → Database → Backups (check what your plan actually
  offers), [Supabase CLI](https://supabase.com/docs/guides/cli).
- **Notes:** the `drafts` + `schedule` → `calendar_entries` backfill is **the
  one irreversible step in the entire project**. Everything else can be
  redeployed.

### Task 11.2 — Dry-run the migration on a restored copy

- **Steps:**
  ```
  npm run verify:migration -- --before snap.json
  npm run db:migrate
  npm run verify:migration -- --after snap.json     # must print RECONCILED
  ```
- **Notes, and this one is a trap worth reading twice:** run the migration
  **through `npm run db:migrate`**, never by pasting SQL into the Supabase SQL
  editor. Migration `0002` contains a guard that aborts the table drops if the
  backfill came up short — it only works inside Drizzle's single transaction.
  In the SQL editor each statement autocommits, the guard raises, and **the
  drops proceed anyway**.
- **Second trap:** seeding a scratch database by piping the base migration
  through `psql` does not write Drizzle's own bookkeeping table, so the next
  `db:migrate` tries to replay it and dies. A restored Supabase snapshot
  carries that bookkeeping with it and is fine; a hand-built scratch database
  is not.
- **Do not run the post-migration read-back checks against production
  carelessly:** one of them (`claimDueForPublish`) reads like a query and is
  actually a write — it moves due rows to `claimed`.

### Task 11.3 — Merge, deploy, migrate, reconfigure — as one operation

- **Steps, in this order:**
  1. Merge the branch to `main`.
  2. Wait for the Vercel deploy to **finish**.
  3. Run `npm run db:migrate` against production.
  4. In Vercel → Settings → Environment Variables, in the same sitting:

     | Action  | Variable                                                                                                      |
     | ------- | ------------------------------------------------------------------------------------------------------------- |
     | update  | `IG_ACCESS_TOKEN` (the six-scope one)                                                                         |
     | confirm | `IG_USER_ID`, `IG_HANDLE`, `LLM_PROVIDER=google`                                                              |
     | add     | `CRON_SECRET`                                                                                                 |
     | delete  | `IMAGE_PROVIDER`, `GOOGLE_MODEL_LITE`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` |

     Tick **all three environments** on anything you add. Do **not** mark
     anything Sensitive.

  5. Redeploy so the new variables are picked up (Vercel does not apply
     environment changes to an already-built deployment).
  6. In GitHub → Settings → Secrets and variables → Actions:
     - **Variable** `TRELLIS_URL` — the stable production domain.
     - **Secret** `CRON_SECRET` — byte-identical to Vercel's.
- **Notes:** the deploy goes first so the code that expects the new schema is
  already live when the schema changes. There is a brief window where v2 code
  runs against a v1 schema; that is a page erroring, which is recoverable. The
  reverse — v1 code against a v2 schema — is every page erroring for as long
  as it takes to notice.

### Task 11.4 — Verify the deployment

- **Steps:**
  1. `npm run verify:cron-auth -- https://your-app.vercel.app` — expect
     **20/20**.
  2. Open `/settings`. Confirm the token panel reports **no missing scopes**
     and the cost total is still $0.00.
  3. Confirm Deployment Protection is still off (Vercel sometimes re-enables
     it on project changes).
- **Notes:** `/settings` reads the resolved values the running function sees.
  Trust it over the Vercel dashboard.

---

## Stage 12 — First live data

### Task 12.1 — The first sync

- **Steps:** enter your handle on the dashboard → run the **Scheduled jobs**
  workflow manually with `daily` → wait → run it again with `weekly`.
- **Resources:** GitHub → Actions → Scheduled jobs → Run workflow.
- **Notes:** the `daily` run pulls your own account through the Graph API. The
  `weekly` run does competitor discovery, the analysis, and then the Gemini
  generation that fills **Opportunities** and **This week**. Both are behind
  the same `CRON_SECRET`; if the workflow logs say the secret or URL is
  missing, it exits cleanly rather than failing loudly — check the log text,
  not just the green tick.

### Task 12.2 — Expect the sparseness, and do not treat it as a bug

- **Notes:** Graph insights **do not backfill**. Every post scraped under v1
  has no reach data and never will. The dashboard will carry a coverage note
  ("N of 132 posts have Instagram insights") for a long time. The tracker will
  show three distinct kinds of blank — _not measured_, _too new_, and a real
  curve — and that distinction is the product working, not failing.
- **What "working" looks like on day one:** account-level numbers present,
  per-post insights only for posts published after the cutover, the follower
  chart holding a single reading with a blank change, and Opportunities either
  populated or honestly reporting that the sample is too small.

### Task 12.3 — Watch the first week for the failures only production produces

- **Watch for:** the hashtag actor's input shape (never verified live, same
  bug class as 7.1); the follower actor's input; Graph metric names that the
  probe did not cover because that media type was absent; the GitHub Actions
  ticker silently no-op'ing because `TRELLIS_URL` points at a preview URL.
- **Resources:** `/settings` recent-runs table; GitHub → Actions run logs;
  Supabase → Logs; Apify → Runs.

---

## Stage 13 — Calibration

**Cannot start before roughly a month of real history exists.**

### Task 13.1 — Re-argue every seed-tuned threshold

- **Resources:** the threshold table in `docs/cutover.md`.
- **Notes:** the "climbing" threshold, the viral-score floor, the topic noise
  floor, the opportunity sample floors and the comment window were all chosen
  against invented data. Each one is a single constant. The question for each
  is the same: _does this fire on things I actually care about, and stay quiet
  otherwise?_

### Task 13.2 — Revisit the dashboard consolidation

- **Notes:** post analytics, the tracker, followers and unfollows were folded
  from four tabs into four sections of one page, because they were four views
  of one question. If any of them turns out to need more room than a section
  gives it, promoting it back to a tab is a small change. Decide this with a
  month of real data on the screen, not before.

### Task 13.3 — Token maintenance becomes a real concern

- **Notes:** long-lived Instagram tokens last ~60 days. There is a weekly
  refresh job, and refreshing early is free. **Verify from the `/settings`
  token panel that it is actually happening** — a silently failing refresh
  looks exactly like a working one until day 61.

---

## Stage 14 — Closing the two known gaps

### Task 14.1 — Rebuild Hot Topics against spec 2.7

- **Blocker:** requires the 2.7 text, which is not in the repository.
- **Notes:** the current page measures hashtag share of things you already
  posted. The spec asked for generated concepts to explore, split by platform.
  Different computation model, different subject matter. It must follow the
  same architecture the Opportunities correction established: **SQL computes
  the evidence → Gemini interprets → code validates every number against the
  payload → the result is cached**, with sample floors applied _before_ the
  model call.

### Task 14.2 — Decide the fate of named unfollows

- **Blocker:** depends on the cost number from Task 10.3.
- **Notes:** three outcomes, all acceptable: keep it as built; degrade it to
  counts-only with no names; or cut it. What is not acceptable is leaving it
  in a state where it quietly spends the month's Apify credit.

---

## Stage 15 — Steady state, i.e. "finished"

The product is finished when all of this is true and stays true without you
intervening:

- [ ] A daily sync lands your own account's posts, insights and comments
      without you opening a browser tab.
- [ ] A weekly pass refreshes the niche, runs the analysis, and regenerates
      Opportunities and the weekly rollup.
- [ ] The Instagram token refreshes itself before it expires, and `/settings`
      proves it.
- [ ] Apify spend stays inside the free monthly allowance, tracked in the
      `runs` ledger and visible on `/settings`.
- [ ] Gemini stays inside the free tier, rationed per job type.
- [ ] Supabase never pauses, because the keepalive writes daily.
- [ ] Every number on every page is either real or blank. No zeros standing in
      for absent data.
- [ ] Every thresholded claim has been checked against a month of real history
      at least once.
- [ ] The only manual acts left are: entering a handle for a new competitor,
      and reading the thing.

---

# PART IV — WHAT WENT WRONG, PLAINLY

Ordered by how much each one cost.

1. **Deployment Protection was left on.** It is on by default and it silently
   breaks every inbound webhook and external scheduler. Cost: a debugging
   cycle in which the scrape succeeded and the app looked broken anyway.
   _Lesson: any app with an inbound webhook needs this checked on day one._

2. **The Apify actor's Input tab was never actually read.** The code's own
   comment said the field names were unverified. They were wrong. Cost: every
   live run failing on a validation error. _Lesson: for any external actor or
   API, read the declared input schema before writing the caller — and where
   that is not possible, probe it cheaply first. This is now Stage 10's whole
   purpose, and there are two more unverified actor inputs waiting._

3. **A ruling about storage was read as a ruling about computation.** "Reuse
   the `analyses` table" pulled v1's deterministic pipeline along with it, and
   two specified Gemini features shipped as SQL. Cost: a full rebuild of two
   features. _Lesson: when a direction touches an area the spec already
   covers, say which one wins. And when the code disagrees with the spec, the
   default assumption is that the code is wrong._

4. **Environment variables marked "Sensitive."** They become write-only, so a
   failed save is indistinguishable from a successful one. Cost: deploy cycles
   chasing a value that had never saved. _Lesson: leave Sensitive off in a
   private project, and confirm every variable change from `/settings`, not
   from the Vercel dashboard._

5. **Environment variables saved without all three environments ticked.** Same
   class, smaller bill.

6. **A database password pasted in plaintext.** Not yet remediated. _It is
   Task 10.5 and it takes two minutes._

7. **Expecting near-instant latency from a queue-based architecture on a free
   tier.** The design is fire-and-return by necessity — a Vercel function
   cannot block on a scrape. The dashboard poller makes it _feel_ fast while
   you are watching; nothing makes it fast when you are not. _Lesson: the
   right question is not "why is this slow" but "what is advancing the queue
   right now", and the answer must never be "a browser tab"._

8. **Building nine stages before the first real deployment.** Every genuine
   infrastructure bug in this project surfaced within hours of first contact
   with real services, and none of them were reachable from local tests or CI.
   _Lesson, and it is the one that generalises furthest: deploy the skeleton
   to real infrastructure at Stage 1, not Stage 7. The bugs that hurt are the
   ones about the shape of other people's systems, and they are only findable
   there._

---

# PART V — WHAT YOU HAVE YET TO DO

Everything below is on you, because it needs credentials, a dashboard login,
or a decision. Nothing in the codebase is blocking any of it.

### Right now — free, local, reversible

- [ ] Confirm the Instagram account is Business/Creator and linked to a Page.
- [ ] Generate a long-lived token with **all six** scopes → local `.env`.
- [ ] `npm run probe:graph -- --json graph-probe.json` → send back the
      **terminal table** (never the JSON file — it holds your account data).
- [ ] Pick a real followers actor in the Apify console and read its Input tab.
- [ ] `npm run probe:apify-followers -- <yourhandle> 20` → send back the cost
      table.
- [ ] Rotate the Supabase database password.

### The cutover window — one sitting, ~1 hour

- [ ] Take a manual Supabase dump and verify it is not empty.
- [ ] Dry-run the migration on a restored copy until `verify:migration` prints
      **RECONCILED**.
- [ ] Merge → wait for deploy → migrate production → change env vars →
      redeploy.
- [ ] Add `TRELLIS_URL` (variable) and `CRON_SECRET` (secret) in GitHub
      Actions.
- [ ] `verify:cron-auth` → 20/20.
- [ ] `/settings` → no missing scopes, $0.00.
- [ ] Confirm Deployment Protection is still off.

### First week

- [ ] Run **Scheduled jobs** manually: `daily`, then `weekly`.
- [ ] Confirm the GitHub Actions ticker is actually firing, against the
      **stable** production domain.
- [ ] Watch for the hashtag and follower actor input shapes to be wrong.
- [ ] Accept the sparse dashboard. Insights do not backfill.

### First month

- [ ] Re-argue every threshold in the `docs/cutover.md` table.
- [ ] Decide whether the four folded dashboard sections want to be tabs again.
- [ ] Confirm from `/settings` that the token refresh job is actually running.
- [ ] Decide the fate of named unfollows based on the measured Apify cost.

### Outstanding product work

- [ ] Supply the **spec 2.7 text** so Hot Topics can be rebuilt as generated
      concepts rather than measured hashtag share. This is the one feature
      currently shipping something other than what was asked for.
- [ ] Decide when `ENABLE_IG_PUBLISHING` turns on — and watch the first
      auto-published post go out by hand before trusting it.

---

# APPENDIX — RESOURCE INDEX

| Thing                                         | Where                                                       |
| --------------------------------------------- | ----------------------------------------------------------- |
| Deployment, env vars, cron, protection        | Vercel → Project → Settings                                 |
| Database, pooler string, password reset, logs | Supabase → Project Settings → Database                      |
| Repository secrets and variables              | GitHub → Settings → Secrets and variables → Actions         |
| The three schedules and the queue ticker      | `.github/workflows/scheduled-jobs.yml`, `pipeline-tick.yml` |
| Vercel's two daily crons                      | `vercel.json`                                               |
| Token generation and scopes                   | `docs/instagram-setup.md`, Meta Graph API Explorer          |
| Token inspection                              | Meta Access Token Debugger, and `/settings`                 |
| Actor input schemas and spend                 | Apify console → Store → Input; → Billing → Usage            |
| Model key and free-tier limits                | Google AI Studio                                            |
| The mechanical cutover checklist              | `docs/cutover.md`                                           |
| Code-level history, bugs and decisions        | `NOTES.md`                                                  |
| Migration verification                        | `npm run verify:migration`                                  |
| Cron auth verification                        | `npm run verify:cron-auth`                                  |
| Graph API probe                               | `npm run probe:graph`                                       |
| Apify follower cost probe                     | `npm run probe:apify-followers`                             |
