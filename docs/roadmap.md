# Trellis — state of the app, and the road to finished

Supersedes the version at commit `c131042`. That document is not deleted; it
is a fair record of what was believed before the first live Graph API probe
and before the MVP was scoped down, and the diff between the two is itself
information.

This document is about the **app as an operated system** — the Vercel project,
the Supabase database, the GitHub repository and its Actions, the Meta app and
its token, the Apify account and its credit — not about the source code. Code
history lives in `NOTES.md`. The mechanical cutover checklist lives in
`docs/cutover.md`.

---

## What changed since `c131042`

Six things, in rough order of how much they move the project.

1. **The MVP was scoped down to two surfaces.** The product is a **grounded
   chat about the owner's own Instagram account**, plus a **dashboard**
   carrying their analytics. Everything else goes behind feature flags,
   default off. `c131042` described a ten-feature product and defined
   "finished" around it; that definition was wrong.
2. **The chat had no stage at all.** It appeared once, as an inherited Stage 7
   artifact. The stated core feature of the product was absent from its own
   roadmap. It now has a stage, and it is the last stage before MVP.
3. **The Graph API probe ran, and the token works.** 50 of 53 expectations
   met. The format-divergence risk the whole per-metric retry path was built
   for **did not materialise** — reels and carousels return identical metric
   sets. Two findings the probe's own reconciliation got wrong are corrected
   below.
4. **There is a seventh scope.** `business_management`. Without it,
   `GET /me/accounts` returns an empty list rather than an error — it reads as
   "this user administers no Pages," not as "this token is short a
   permission." Every "six scopes" claim in the old document is wrong.
5. **"Graph insights do not backfill" is not supported by the evidence.** A
   post roughly five months old returned full lifetime insights during the
   probe. The old document stated the opposite as settled fact. This is now
   the highest-value open question in the project, because it decides whether
   the chat reasons from twenty posts or two.
6. **Apify came off the critical path.** It feeds only flagged-off features.
   Recurring cost drops to zero and the Terms-of-Service exposure goes with
   it, for as long as those features stay hidden.

---

## How to read this

Stages are grouped into **Part III (MVP — required to ship)** and **Part IV
(post-MVP — parked)**. Inside a stage, **tasks** are units of work you could
stop after; **steps** are the actual clicks and commands. Every task carries
**Resources**, **Notes**, and **Blockers**.

Claims are tagged, because the previous version's worst error was stating an
assumption as a fact and thereby stopping anyone from asking the question:

| Tag                       | Means                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `[VERIFIED-LIVE]`         | Observed in a real API response or terminal session. Outranks this document, the code, the fixtures, and Meta's docs.                  |
| `[OWNER-STATED]`          | Reported by the account owner about their own accounts or dashboards. Not checkable from the repository. Not to be re-verified.        |
| `[DECISION]`              | A product decision. Not a discovery and not up for re-litigation here.                                                                 |
| `[CONFIRMED-UNKNOWN]`     | A specific question, asked and unanswered, with a known method for answering it. Every one has a named resolution method and an owner. |
| `[UNVERIFIED-ASSUMPTION]` | Asserted somewhere — in code, in docs, or by me — with no evidence behind it.                                                          |
| `[REPO-CONFIRMED]`        | Checked against the source at this commit.                                                                                             |

Where a claim carries no tag it is either narrative or history.

---

## 0. Where we are right now

There are still **two Trellises**. The one that is _deployed_ — on `main`,
live on Vercel, against a real Supabase database — is **v1**, the generative
product. The one that is _built_ — sixteen commits on a branch, 246 tests
green — is **v2**.

What has changed since `c131042` is that v2 is no longer entirely unproven.
The Meta app exists, the token works, and the Graph API has been probed
successfully against the real account. **The read path is no longer a
hypothesis.** What remains unopened is the deploy window, and what remains
unbuilt is the thing the product is actually for.

The honest summary: **the plumbing is verified, the product is not built.** A
chat that reads v2 data does not exist yet — the six tools that exist read
v1's scraped tables. That is now the critical path.

### Established live values `[OWNER-STATED]` / `[VERIFIED-LIVE]`

| Item                        | Value                                                                       |
| --------------------------- | --------------------------------------------------------------------------- |
| Meta app                    | `trellis`, App ID `4365362137020369`                                        |
| Facebook Page               | `Skincaring`, id `223324307523350`                                          |
| Instagram account           | `glowithuzma`, **Creator** (not Business), linked to the Page               |
| `IG_USER_ID`                | `17841402326320043`                                                         |
| Page tasks granted          | `MANAGE`, `CREATE_CONTENT`, `MODERATE`, `MESSAGING`, `ADVERTISE`, `ANALYZE` |
| Token                       | long-lived user token, ~60 day expiry, verified in the debugger             |
| Account shape at probe time | 4,881 followers · 891 following · 228 media                                 |
| Last 10 posts by type       | 9 × `CAROUSEL_ALBUM`/`FEED`, 1 × `VIDEO`/`REELS`, **0 images**              |

---

# PART I — HISTORY

Stages 0 through 9 are what has already happened. Stage 7 and the "what went
wrong" list in Part VI are preserved verbatim from `c131042` — they were the
most useful things written about this project and a rewrite is the easiest
place to lose them.

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
  the managed account through Meta's own API. That means a token with **seven**
  scopes, and it means the account must be a Business or Creator account
  linked to a Facebook Page.
- **Scraping shrank to competitors only**, then — under the MVP decision in
  Part III — to nothing that ships.
- **Three new schedules** that Vercel cannot host (both cron slots spent), so
  they live in `.github/workflows/scheduled-jobs.yml`: a daily own-account
  sync at 23:00 UTC (02:00 Riyadh) and a weekly niche + token pass at 00:00
  UTC Monday.
- **Five environment variables become dead** (`IMAGE_PROVIDER`,
  `GOOGLE_MODEL_LITE`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_STORAGE_BUCKET`) and one must be **rotated** in production
  (`CRON_SECRET` — see the environment appendix for why it cannot simply be
  copied).

### What the pivot did not do, and this is the gap the MVP decision exposes

**It never moved the chat.** `[REPO-CONFIRMED]` `lib/chat/tools.ts` still
reads v1's scraped `posts` table, the competitor pool, and the `analyses`
table. Not one of its tools touches `post_insights`, `post_comments`,
`follower_daily`, `follower_snapshots` or `calendar_entries`. Ten analytics
views were built on top of the new data and the one surface a person actually
talks to was left pointed at the old data. See Stage 14.

### The governing product rule, worth stating because it drives every blank cell you will see

> **A number that is not known renders blank, never zero.** A believable wrong
> number is worse than no number.

Under the scoped-down MVP this becomes **more** load-bearing, not less. It is
the chat's entire differentiator. Every competing tool will bolt an LLM onto
Instagram data; almost none of them will refuse to invent a number.

---

## Stage 9 — Verification (v2 Task 3, and first contact with the Graph API)

**Status: the local half passed. The live half has now partly run, and it
found things.**

### Verified locally, before any credential existed

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

### The Graph API probe — 50/53 `[VERIFIED-LIVE]`

`npm run probe:graph` ran against the real account. What it settled:

**The seventh scope.** With six scopes, `GET /me/accounts` returned
`{"data": []}` while `GET /me?fields=id,name` returned the correct profile —
so the token was valid and belonged to the right user, and the Page list was
simply empty. Adding `business_management` and regenerating returned the Page.
**The failure mode is the finding:** a missing permission presenting as an
empty collection rather than an error is exactly the silent-failure class this
project catalogues elsewhere, and it cost a debugging cycle because an empty
array looks like an answer.

> `[CONFIRMED-UNKNOWN]` — **is `business_management` needed at runtime, or only
> at setup?** `[REPO-CONFIRMED]` the app never calls `/me/accounts`; it reads a
> configured `IG_USER_ID` directly. So the scope is proven necessary for
> _discovering_ the Page during setup, and unproven for the ongoing insight
> reads. It goes into `REQUIRED_SCOPES` regardless — the cost of requiring a
> scope you did not need is zero, and the cost of a token regenerated without
> it is a setup you cannot repeat. **Resolution method:** if a future token is
> ever generated without it and the reads still work, record that. Do not go
> out of your way to test it.

**No format divergence — the risk was not real.** `[VERIFIED-LIVE]` Reel and
carousel both return all seven media metrics (`reach`, `views`, `saved`,
`shares`, `likes`, `comments`, `total_interactions`), identical shapes,
`period: lifetime`. The batched request succeeds for both; **the per-metric
retry path never fired.** Keep the retry path — as insurance against version
drift, explicitly, not as an unresolved worry. The document and the code
should both stop treating asymmetric metric availability as an open risk.

**`shortcode` is present** (`DcRHHmdiOTD` on the newest post). This was an open
question. It resolves the join key back to the v1-scraped `posts` rows.
`[UNVERIFIED-ASSUMPTION]`: that it is present on _every_ media type — the
probe saw the newest post, not one of each. This matters more than it looks:
`[REPO-CONFIRMED]` `lib/insights/graph.ts` **drops a media item entirely** when
`shortcode` resolves to null. A type that omits it would lose posts silently
rather than storing them incomplete.

**`thumbnail_url` is type-conditional, and the probe misreported it.**
`[VERIFIED-LIVE]` The reconciliation marked it ABSENT because it inspected the
first media item, a carousel; the reel in the same response has it populated.
Real rule: present on `VIDEO`/`REELS`, absent on `CAROUSEL_ALBUM`/`IMAGE`,
which carry `media_url` instead.

> **The mapper does not need fixing.** `[REPO-CONFIRMED]`
> `lib/insights/graph.ts` already stores
> `raw.thumbnail_url ?? raw.media_url ?? null`, which handles both cases
> correctly. **The probe does.** Its reconciliation must inspect an item of
> each media type before declaring any field absent, or it will keep emitting
> this false negative on every type-conditional field — and a probe that cries
> wolf gets ignored, which is worse than one that stays quiet.

**API version mismatch.** `[VERIFIED-LIVE]` The probe announces "Probing Graph
API v21.0" and its header says v21.0, while every URL in every response comes
back **v26.0**. `[REPO-CONFIRMED]` `lib/publish/graph.ts` hardcodes
`https://graph.facebook.com/v21.0` and `scripts/probe-graph.ts` defaults to
`v21.0` via `GRAPH_API_VERSION`. Meta is silently upgrading calls to a
deprecated version. **This is the exact mechanism the per-metric retry was
built to survive** — `impressions` became `views`, `plays` folded into it —
and it is currently happening without anything in the app knowing.

**Image media could not be probed.** No image posts exist in the last 10.

**`follows_and_unfollows` returned no values.** `[CONFIRMED-UNKNOWN]` — see the
open-questions register in Part V.

**A post from `2026-03-29` returned full lifetime insights.**
`[VERIFIED-LIVE]` — reach 128, views 144, saved 1, shares 0, likes 3, comments
0, total_interactions 4. Roughly five months of history, served on request.
This contradicts the previous document's flat assertion that insights do not
backfill. See the open-questions register; it is the most consequential
unresolved item in the project.

### Still prepared but never run

`scripts/probe-apify-followers.ts` (now post-MVP) and
`scripts/verify-cron-auth.ts` against the production URL (cutover window).

---

# PART II — THE GOOD, THE BAD, AND THE DOWNRIGHT UGLY

## The good

- **The read path is proven.** This is new since `c131042` and it is the
  single biggest de-risking event in the project. The Meta app exists, the
  token works, media and insights and comments all return, and the thing most
  feared — metric availability differing by media type — turned out not to be
  a thing.
- **The $0 target held.** No paid provider has ever been instantiated; a guard
  throws at startup if one is, naming it. Under the MVP scope, recurring cost
  goes to **zero** — the Graph API is free and Apify stops running entirely.
- **The honesty discipline is real and it has teeth.** Blank-not-zero is
  enforced at the query layer, and the Gemini interpretation layer validates
  that **every number in the model's output appears verbatim in the
  SQL-computed input** — in code, not as a polite instruction in a prompt.
- **The GitHub Actions escape hatch.** Discovering that an external scheduler
  sidesteps Vercel's cron cap turned a hard platform ceiling into a
  non-problem, for free.
- **Migrations are reconcilable.** The one irreversible step in the project
  has a two-pass verification script that names any row that fails to carry
  over, and a guard inside the migration itself that aborts the drop if the
  backfill came up short.
- **CI runs against a real Postgres**, which caught driver-level bugs no mock
  would have.
- **Nothing needs deleting to scope down.** Ten features go behind flags, not
  into the bin. The code is early, not wrong.

## The bad

- **Two Trellises, one database.** The deployed app and the built app disagree
  about the schema, so the migration cannot be run early "to get it out of the
  way" — it would break production instantly. Everything is bottlenecked on
  one window.
- **The chat — the product — reads the wrong tables.** `[REPO-CONFIRMED]` Six
  tools, all pointed at v1's scraped data. Post-cutover it would answer
  questions about the owner's account using Apify-scraped like counts while
  real Graph insights sat unused in the next table over, and would answer
  competitor questions from a feature that is about to be flagged off. This is
  not a polish item; it is the MVP.
- **The API version is unpinned in practice.** v21.0 requested, v26.0 served,
  nothing in the app aware of the difference.
- **The account posts one format.** Nine carousels and one reel in the last
  ten. Any "by format" comparison is a comparison of one thing against a
  sample of one, and `[REPO-CONFIRMED]` `summariseByFormat` — the function the
  chat's `getAccountStats` tool returns — applies **no sample floor at all**.
  It will hand the model a two-row table that implies a finding.
- **Every analytics threshold is seed-tuned.** "Climbing", the viral-score
  floor, the topic noise floor, the opportunity sample floors — all chosen
  against invented data. Listed with their current values in
  `docs/cutover.md`.
- **No automated backups.** Supabase Free does not provide them, so the one
  irreversible operation in the project depends on a manual dump.
- **Credentials cannot be read back.** Every Vercel variable is marked
  Sensitive and cannot be un-marked, so the local `.env` holds placeholders and
  `CRON_SECRET` has to be rotated rather than copied.

## The downright ugly

- **The 11-hour stall.** A scan left running overnight sat frozen on
  millisecond-long jobs because the only thing advancing the queue was a
  browser tab. Fixed — but it is why the GitHub Actions ticker is not optional
  infrastructure.
- **"Insights do not backfill" was written down as fact and it was not
  checked.** The previous document said every v1-scraped post has no reach data
  and never will. A five-month-old post returned full insights on the first
  real probe. The error is not the wrong guess; it is that a confident sentence
  in a roadmap **stops people asking the question**, and this particular
  question decides whether the chat has twenty posts to reason from or two.
  Everything in this document is tagged now because of this one paragraph.
- **A ruling that quietly overrode the spec.** A direction to reuse the
  `analyses` table was about _where output lives_. It was applied as _how
  output is produced_, and two specified Gemini features shipped as pure SQL.
  Worse, when the discrepancy was noticed it was written up as a correction to
  the brief rather than a deviation from it. **Finding that the code disagrees
  with the spec is not evidence that the spec is wrong.**
- **Hot Topics is still not what 2.7 asked for** — measured hashtag share
  where the spec wanted generated concepts. Under the MVP decision the tab is
  hidden, so this stops being urgent, but it does not stop being true.
- **Ten features were built before the one feature.** The chat is the product.
  It got one stage in v1 and none in v2, while ten analytics views got a stage
  each. This is the same mistake as nine stages before the first deployment,
  in a different dimension: building outward from what was easy to specify
  rather than inward from what the thing is for.

---

# PART III — THE MVP

**The MVP is a grounded chat about the owner's own Instagram account, plus a
dashboard carrying their analytics.** `[DECISION]`

The reasoning governs every scoping call after it, so it belongs here rather
than in a footnote: **a chat with no grounding is Gemini with extra steps, and
anyone can get that for free.** The product is not that there is an LLM. The
product is that it knows _their account_ — their posts, their insights, their
comments, their follower history — and that it will not make a number up.

Everything else — Ideas, Hot Topics, Weekly, Opportunities, Competitors,
Tracker, Unfollows, Audience, Calendar — goes behind feature flags, default
off. **None of it is deleted.** The code is early, not wrong; flagged off it is
the post-MVP roadmap, and deleting it to rebuild later would be the same
mistake as building it early, in reverse.

Post-flag navigation: **Dashboard · Chat · Settings**.

Five stages remain. Stage 10 is partly done.

---

## Stage 10 — Pre-cutover ← **YOU ARE HERE**

**Free, local, read-only, reversible. Nothing here touches production.**

### Task 10.1 — Meta app, Page, and a seven-scope token ✅ **DONE**

- **Status:** complete. `[VERIFIED-LIVE]`
- **What was established:** the `trellis` app, the `Skincaring` Page, the
  `glowithuzma` Creator account linked to it, `IG_USER_ID`
  `17841402326320043`, and a long-lived token with ~60 days of life, held in
  the local `.env` only.
- **The finding that came out of it:** the token needs **seven** scopes, not
  six. `business_management` is the seventh, and without it the Page list
  comes back empty rather than erroring.
- **Notes:** `[OWNER-STATED]` the account is **Creator**, not Business.
  Insights, media and comments all work.
  `[UNVERIFIED-ASSUMPTION]`: Creator accounts have historically had narrower
  support than Business for the **content publishing** API specifically. This
  is not urgent — publishing is off — but it is recorded here because if
  auto-publish ever fails on a permissions error _despite_
  `instagram_content_publish` being granted, **switching Creator → Business is
  the first thing to try**, and without this note the failure would look like
  a scope problem and waste a day.

### Task 10.2 — Probe the Graph API ✅ **DONE**

- **Status:** complete, 50/53. `[VERIFIED-LIVE]`
- **Resources:** `scripts/probe-graph.ts`, `npm run probe:graph`.
- **Findings:** written up in Stage 9. In short — no format divergence,
  `shortcode` present, `thumbnail_url` type-conditional (probe wrong, mapper
  right), API version mismatch, `follows_and_unfollows` empty, insights served
  for a five-month-old post.
- **Note on handling output:** keep the terminal reconciliation table. The
  JSON file holds real account data and is gitignored for that reason.

### Task 10.3 — Add the seventh scope everywhere it is asserted

- **Steps:** add `business_management` to `REQUIRED_SCOPES` in
  `lib/publish/graph.ts`, then fix every place that independently repeats the
  list:
  - `scripts/probe-graph.ts` — `[REPO-CONFIRMED]` keeps its **own hardcoded
    copy** of the five required scopes rather than importing them, deliberately
    (the probe imports nothing from the app's Graph code, so that it cannot
    confirm the app's own assumptions). That independence is right; the cost
    is that this list must be updated by hand.
  - `docs/instagram-setup.md` — the scope table.
  - `docs/cutover.md` — the six-line scope block.
  - `.env.example` — the comment block.
  - `README.md` — "all six scopes".
- **Resources:** `/settings` token panel, which `[REPO-CONFIRMED]` renders
  `missingScopes` and `missingPublishingScopes` from `inspectToken` and needs
  no change beyond the constant.
- **Notes:** commit `a38bcc6` added `instagram_content_publish` as the sixth.
  It predates this finding and did not add the seventh. `business_management`
  belongs in `REQUIRED_SCOPES` rather than a third category — it is proven
  necessary for setup, unproven for runtime, and the asymmetry of costs says
  require it.
- **Blockers:** none.

### Task 10.4 — Pin the API version, and put it on the screen

- **Steps:**
  1. Decide the version deliberately. `[VERIFIED-LIVE]` Meta is serving v26.0
     against v21.0 requests.
  2. Set it in one place — `lib/publish/graph.ts`'s `GRAPH` constant is the
     single base URL `[REPO-CONFIRMED]`; `lib/insights/graph.ts` has no version
     of its own and routes through the same `call()`.
  3. Make `scripts/probe-graph.ts` agree, and make its fixtures agree.
  4. **Surface the version string on `/settings`** so drift is visible without
     reading a response body.
- **Notes:** a hardcoded version disagreeing with what the API actually serves
  is precisely how a metric gets renamed underneath you — `impressions` became
  `views`, `plays` folded into it. The per-metric retry path exists for that,
  and it cannot fire on a rename it does not know happened. This is a small
  change guarding a large failure.
- **Blockers:** none.

### Task 10.5 — Fix the probe's type-conditional false negative

- **Steps:** make the reconciliation inspect **one media item of each type**
  before declaring any field absent.
- **Notes:** it reported `thumbnail_url` ABSENT off a carousel while a reel in
  the same response carried it. The mapper is already correct; the probe is
  not. This matters beyond one field: a probe that produces false alarms gets
  discounted, and a discounted probe is worse than none, because the next real
  finding gets waved through with it.
- **Blockers:** none.

### Task 10.6 — Probe how far back insights actually go ★ **highest value**

- **`[CONFIRMED-UNKNOWN]`: where does the insights lookback end?**
- **Why it is the highest-value item in the project:** it decides whether the
  chat can answer "how did my last twenty posts do" or only "my last two". A
  grounded chat with two data points is not a product. Every decision in Stage
  14 — tool design, sample floors, what the acceptance test can even ask —
  moves depending on this answer.
- **Resolution method:** a new standalone probe, same pattern as
  `probe-graph.ts` — read-only, importing nothing from the app's Graph code.
  Walk the media edge with pagination, request insights for posts at
  increasing age, and report **the oldest post that returns data and the first
  that does not**.
- **Owner:** the account owner runs it; they hold the token. What to send back:
  the terminal table, not the JSON.
- **Notes:** the evidence that prompted this is a single post dated
  `2026-03-29` returning full lifetime insights — reach 128, views 144, saved
  1. That is one data point proving the old "never" wrong; it is not a
     boundary. Do not replace one confident sentence with another.
- **Blockers:** none. This can be written and run today.

### Task 10.7 — Credential hygiene

- **What is settled:** the **Meta app secret** was exposed and **has already
  been rotated**. `[OWNER-STATED]` Nothing further is needed there.
- **What is not:** whether a **Supabase database password** was separately
  exposed is `[UNVERIFIED-ASSUMPTION]`. The previous version of this document
  asserted it and scheduled a rotation. That assertion is withdrawn.
- **Steps, conditional:** rotate the database password **only if it was in fact
  exposed**. Supabase → Project Settings → Database → Reset database password,
  then update `DATABASE_URL` in Vercel across all three environments.
- **Notes:** rotating is **not free**. It invalidates the connection string
  Vercel currently holds and **production is down until Vercel is updated**.
  If it is done, do it in this stage — with a working app to debug against —
  and never inside the cutover window, where a bad connection string would be
  indistinguishable from a bad migration.
- **`CRON_SECRET` is a separate matter and it is not optional:** see Task 12.3.

---

## Stage 11 — Scope down to three tabs

**Code work, and it lands before the merge — the flags change what the
deployed app shows on the day it goes live.**

### Task 11.1 — A flag mechanism

- **Steps:** `[REPO-CONFIRMED]` `lib/env.ts` currently carries exactly one
  feature flag (`ENABLE_IG_PUBLISHING`). Extend the same pattern rather than
  inventing a second one — parsed, defaulted, and rendered on `/settings`
  alongside the others.
- **Notes:** the flags must be **readable from `/settings`**. That page renders
  resolved values from the running function and has repeatedly proved a more
  reliable way to confirm a Vercel environment change than the Vercel
  dashboard. A flag you cannot see the state of is a flag you will misconfigure.
- **Blockers:** none.

### Task 11.2 — Flag nine features off; nav becomes three items

- **Off by default:** Ideas, Hot Topics, Weekly, Opportunities, Competitors,
  Tracker, Unfollows, Audience, Calendar.
- **Steps:** hide the nav entries, and make the routes themselves refuse
  rather than render — a hidden tab still reachable by URL is a half-shipped
  feature. Keep the folded dashboard sections consistent with their flags:
  tracker, followers and unfollows are sections of the dashboard now, so
  flagging those features off means removing those sections, not just a nav
  item.
- **Notes:** **do not delete anything.** Off is a configuration state, not a
  deletion. The post-MVP roadmap in Part IV is these features.
- **Blockers:** none.

### Task 11.3 — Turn off the weekly Apify pass with the features it feeds

- **Steps:** disable the weekly schedule in
  `.github/workflows/scheduled-jobs.yml`, or gate the endpoint behind the same
  flags. Leave the daily own-account sync running — that is Graph API and it
  is the MVP's data.
- **Notes, and this is worth stating explicitly because it is a real benefit
  and not just tidiness:** Apify feeds **only** flagged-off features. Turning
  it off drops recurring cost to **zero** and removes the Terms-of-Service
  exposure entirely for as long as those features stay hidden. That exposure
  comes back the day they do — see Task 17.3.
- **Keep:** the `runs` budget ledger and its guard. They cost nothing, they are
  correct, and they are what makes turning Apify back on safe.
- **Keep also, and do not lose in the reorganisation:** the hashtag actor's
  input shape and the followers actor's input shape are both
  `[UNVERIFIED-ASSUMPTION]`s **of the same class as the `username`/`usernames`
  bug that broke v1 in production** (Blocker 7.1). Hiding the features does not
  verify the assumptions; it defers them.

### Task 11.4 — Make the dashboard honest about a single-format account

- **The fact:** `[VERIFIED-LIVE]` the last 10 posts are 9 carousels and 1 reel.
  No images. This is not a data gap — it is the account's actual posting
  pattern.
- **The consequence:** a "by format" comparison across one format is
  meaningless. The single reel shows reach 128 against a carousel around 146,
  on a sample of one, and rendered as a two-row table that reads as a finding.
- **Steps:**
  1. Apply a minimum sample per format before that format enters any
     comparison. `[REPO-CONFIRMED]` the floors already exist elsewhere and are
     the model: `MIN_FORMAT_SAMPLE = 3` and `MIN_MEASURED_POSTS = 5` in
     `lib/generate/payload.ts`, `MIN_SAMPLE = 5` in `opportunities.ts`,
     `MIN_POSTS_FOR_BASELINE = 5` in `ideas.ts`.
  2. When only one format clears the floor, **say so** — the account posts
     predominantly one format and the comparison is unavailable. Do not render
     two rows.
  3. Fix `summariseByFormat` in `lib/analysis/features.ts`, which
     `[REPO-CONFIRMED]` applies **no floor at all** and is what the chat's
     `getAccountStats` tool hands to the model. This is the more urgent of the
     two: the dashboard's own `byFormat` in `lib/analytics/posts.ts` already
     carries `measuredCount` and renders `17 (2 measured)`.
- **Notes:** that `17 (2 measured)` pattern — a median declaring its real
  sample size rather than hiding behind the population count — is exactly
  right and is the model for all of this.
- **Blockers:** none.

---

## Stage 12 — The cutover window

**One sitting. Not a Tuesday task and a Thursday task.**

The reason is not caution for its own sake: `main` still runs v1, and v1 reads
`drafts` and `schedule` in eight files. The moment migration `0002` drops those
tables, the deployed app is querying tables that do not exist. The same applies
to the environment variables — v1's slide rendering reads `IMAGE_PROVIDER` and
`SUPABASE_STORAGE_BUCKET`, so deleting them while v1 is live breaks it.

**A backup makes the data recoverable. It does nothing about the app being
broken in between.** It is a personal app, so a few minutes of downtime costs
nothing — but it has to be a few minutes.

### Task 12.1 — Back up Supabase

- **Steps:** take a full dump before anything else. Supabase Free has **no
  automated backups** — use the Supabase CLI (`supabase db dump`) or `pg_dump`
  against the pooler connection string. Verify the dump is non-empty and
  contains `drafts` and `schedule` rows before proceeding.
- **Resources:** Supabase → Database → Backups (check what your plan actually
  offers), [Supabase CLI](https://supabase.com/docs/guides/cli).
- **Notes:** the `drafts` + `schedule` → `calendar_entries` backfill is **the
  one irreversible step in the entire project**. Everything else can be
  redeployed.
- **Blockers:** `[OWNER-STATED]` `DATABASE_URL` in the local `.env` is the
  placeholder string, because the Vercel variable is Sensitive and
  `vercel env pull` returns `[SENSITIVE]`. The real value has to come from the
  Supabase dashboard by hand before any of this runs.

### Task 12.2 — Dry-run the migration on a restored copy

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
- **Third trap:** do not run the post-migration read-back checks carelessly
  against production. One of them (`claimDueForPublish`) reads like a query and
  is actually a **write** — it moves due rows to `claimed`.

### Task 12.3 — Merge, deploy, migrate, reconfigure — as one operation

- **Steps, in this order:**
  1. Merge the branch to `main`.
  2. Wait for the Vercel deploy to **finish**.
  3. Run `npm run db:migrate` against production.
  4. In Vercel → Settings → Environment Variables, in the same sitting:

     | Action     | Variable                                                                                                      |
     | ---------- | ------------------------------------------------------------------------------------------------------------- |
     | update     | `IG_ACCESS_TOKEN` (the **seven**-scope one)                                                                   |
     | confirm    | `IG_USER_ID` (`17841402326320043`), `IG_HANDLE`, `LLM_PROVIDER=google`                                        |
     | **rotate** | `CRON_SECRET` — generate a new value, set it here **and** in GitHub                                           |
     | add        | the new feature flags, all off                                                                                |
     | delete     | `IMAGE_PROVIDER`, `GOOGLE_MODEL_LITE`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` |

     Tick **all three environments** on anything added.

  5. **Redeploy** so the new variables are picked up. Vercel does not apply
     environment changes to an already-built deployment.
  6. In GitHub → Settings → Secrets and variables → Actions:
     - **Variable** `TRELLIS_URL` — the stable production domain, not a
       per-deployment URL.
     - **Secret** `CRON_SECRET` — byte-identical to the value just set in
       Vercel.

- **Notes on `CRON_SECRET`, because the previous document got this wrong:** it
  says "add `CRON_SECRET`" as though it were new. `[OWNER-STATED]` it **already
  exists in Vercel and is unreadable** — Sensitive, and `vercel env pull`
  returns `[SENSITIVE]`. GitHub Actions needs a byte-identical value and there
  is no way to read the existing one. **So it must be rotated in both places.**
  Generate once, paste twice, in the same sitting.
- **Notes on ordering:** the deploy goes first so the code that expects the new
  schema is already live when the schema changes. There is a brief window where
  v2 code runs against a v1 schema; that is a page erroring, which is
  recoverable. The reverse — v1 code against a v2 schema — is every page
  erroring for as long as it takes to notice.

### Task 12.4 — Verify the deployment

- **Steps:**
  1. `npm run verify:cron-auth -- https://your-app.vercel.app` — expect
     **20/20**.
  2. Open `/settings`. Confirm: **no missing scopes** (all seven), the API
     version string reads what you pinned, every feature flag reads off, and
     the cost total is $0.00.
  3. Confirm Deployment Protection is still off — it gates every inbound
     webhook and external scheduler, and it can come back on across project
     changes.
- **Notes:** `/settings` reads the resolved values the running function sees.
  Trust it over the Vercel dashboard.

---

## Stage 13 — First live data, and the backfill question

### Task 13.1 — The first sync

- **Steps:** enter the handle on the dashboard → run the **Scheduled jobs**
  workflow manually with `daily` → wait for it to finish.
- **Resources:** GitHub → Actions → Scheduled jobs → Run workflow.
- **Notes:** under the MVP scope the `weekly` run is no longer part of first
  light — it does competitor discovery and the Gemini generation behind
  flagged-off tabs. Run `daily` only.
- **Blockers:** if the workflow logs report a missing secret or URL it **exits
  cleanly rather than failing**, so a green tick is not proof. Read the log
  text.

### Task 13.2 — Establish the real insights boundary, then act on it

This replaces the previous document's Task 12.2, which asserted:

> Graph insights **do not backfill**. Every post scraped under v1 has no reach
> data and never will.

**That claim is withdrawn.** `[VERIFIED-LIVE]` A post from `2026-03-29`
returned full lifetime insights during the probe.

- **Steps:**
  1. Run the lookback probe from Task 10.6, if it has not been run already.
  2. **If history is deep** — add a backfill task: walk the full media edge,
     request insights per post, record which return data and which do not, and
     populate `postInsights`. `[VERIFIED-LIVE]` `shortcode` is present, so the
     join back to the existing v1-scraped `posts` rows holds.
  3. **If history is shallow** — the previous framing is roughly right and the
     dashboard carries a coverage note for a long time.
  4. Either way, rewrite the "expect sparseness" language around **the boundary
     the probe actually found**, with the date in it.
- **Notes:** the distinction between _not measured_, _too new_, and a real
  curve stays correct in both worlds. It is only the word "never" that has to
  become a number.
- **Blockers:** Task 10.6.

### Task 13.3 — Watch the first week for the failures only production produces

- **Watch for:** the API version drifting again under a pinned constant; Graph
  metric names the probe did not cover because that media type was absent
  (**no image posts exist** — the first image the account publishes is the
  first live test of that path); the GitHub Actions ticker silently no-op'ing
  because `TRELLIS_URL` points at a preview URL rather than the stable domain.
- **Resources:** `/settings` recent-runs table; GitHub → Actions run logs;
  Supabase → Logs.
- **Notes:** Apify is off under the MVP scope, so two of the classic failure
  modes — actor input drift and webhook delivery — are not in play. They return
  with the features.

---

## Stage 14 — The chat: the actual product

**This is the MVP's last stage and its largest. Everything before it is
plumbing.**

The acceptance test for the whole stage, stated up front because it is what
"done" means: **ask it something that could not be asked of a general-purpose
chatbot** — _"which of my posts held reach best after 48 hours?"_ If it cannot
answer that from real data, the MVP is not done.

### Task 14.1 — Audit what the chat currently is ✅ **done, and the answer is worse than expected**

`[REPO-CONFIRMED]` at this commit:

- **There are six tools, not seven.** The previous document said seven; that
  was wrong. `lib/chat/tools.ts` exports `getAccountStats`, `getPosts`,
  `getCompetitorStats`, `getCurrentPatterns`, `getMyWinners`, `listAccounts`.
- **Every one of them reads v1 data.** `getAccountStats` and `getPosts` read
  the scraped `posts` table — Apify-shaped `likes`/`comments`/`views`.
  `getCompetitorStats` reads the competitor pool. `getCurrentPatterns` reads
  `analyses`. `getMyWinners` mines the back catalogue. **Not one touches
  `post_insights`, `post_comments`, `follower_daily`, `follower_snapshots` or
  `calendar_entries`.**
- **Context is passed as tools, not stuffed** — this part is right and should
  be kept. `lib/prompts/chat-system.v1.ts` carries only handle, niche,
  followers, post count, competitor count and one pattern claim, and says
  explicitly "You do not have the post corpus in front of you."
- **The honesty rules exist only as prompt text.** The system prompt says
  _"Never state a statistic you have not fetched this conversation"_ and _"If a
  tool returns nothing, say the data is not there."_ Both are correct
  instructions and **neither is enforced**. This is precisely the arrangement
  the Opportunities correction ruled insufficient.
- **Two tools become wrong the moment the flags land.** `getCompetitorStats`
  and the system prompt's "benchmarked against N accounts" both describe a
  feature that is about to be hidden.

**What this means in plain terms:** after the cutover, the chat would answer
questions about the owner's account using stale scraped like-counts while real
Graph insights sat unused in the next table over. And the acceptance-test
question is **unanswerable today** — there is no tool that returns per-post
insight history, so "held reach best after 48 hours" has no data path at all.

### Task 14.2 — Build the tool surface over v2 data

- **Steps:** replace the tool set with one that reads what v2 actually holds:
  - posts with their insights attached,
  - **per-post insight history by checkpoint** (`t24`, `t48`, `t7d`, `latest`)
    — this is the one that makes the acceptance test answerable,
  - comments and commenters,
  - the follower series day by day,
  - computed medians and baselines, so the model asks for a benchmark rather
    than deriving one.
- **Notes:** **Gemini decides what to fetch; the app does not pre-stuff.** The
  existing design already works this way and it is also what keeps a turn
  inside the free tier's per-minute token limit. Keep the shape, change the
  targets.
- **Notes on the competitor tools:** they read a flagged-off feature. Either
  gate them behind the same flag or drop them from the tool set while the flag
  is off — a tool that returns "no accounts" against a hidden feature invites
  the model to explain an absence that is really a configuration.
- **Blockers:** Task 13.2. How much per-post insight history exists determines
  whether a "history by checkpoint" tool has anything to return.

### Task 14.3 — Port the numeric validator into the chat

- **Steps:** reuse `lib/generate/validate.ts` — `[REPO-CONFIRMED]` it already
  exports the reusable primitives: `allowedNumbers(payload)`,
  `numbersIn(text)`, `unbackedNumbers(text, allowed)`. Build the allowed set
  from **what the tools actually returned this turn**, and check the model's
  numbers against it.
- **The rule, unchanged from the Opportunities correction:** every number the
  chat states must appear in what a tool returned. **Drop the claim, do not
  caveat it** — a wrong number with a hedge is still a wrong number.
- **Why it matters more here than anywhere else:** open questions invite
  invented figures, and unlike a cached weekly artifact there is **nothing to
  inspect afterwards**. A bad number in a chat message is seen once, believed,
  and gone.
- **A real design problem to solve, not hand-wave** `[REPO-CONFIRMED]`: the
  existing validator operates on **structured, citable objects** —
  `validateInsights` drops whole insight records. Chat output is **free-form
  streaming text**, and you cannot retract tokens already sent to the browser.
  Three workable shapes, and this needs a decision rather than a default:
  1. **Validate before flush** — buffer the final message, validate, then
     stream. Loses the streaming feel; simplest and safest.
  2. **Non-streaming final answer** — stream tool-call progress, deliver the
     answer whole.
  3. **Drop-and-regenerate** — validate post-hoc, and on failure replace the
     message with a regenerated one. Worst of both; a visible retraction is a
     trust cost.
     Option 1 or 2. The streaming animation is not worth a fabricated number.
- **Blockers:** none technical. Needs the shape decision above.

### Task 14.4 — Thin-data honesty

- **Steps:**
  1. The chat **must decline to compare formats** when only one format clears
     a sample floor. `[VERIFIED-LIVE]` this is the account's actual situation
     today — nine carousels, one reel, no images — so this is not a defensive
     edge case, it is the default state.
  2. It **must say how many posts it is reasoning from**, every time it
     reasons from a number.
  3. The floors are the ones already in the codebase (Task 11.4), applied
     **before** the model call, exactly as `lib/generate/payload.ts` does it.
- **Notes:** the model for the phrasing is the dashboard's `17 (2 measured)` —
  the sample size travels with the statistic instead of being available on
  request.

### Task 14.5 — The acceptance test

- **Steps:** ask _"which of my posts held reach best after 48 hours?"_ against
  real data, and check the answer against the database by hand.
- **Then ask the questions designed to make it lie:**
  - "Do reels or carousels do better for me?" → must decline; one format.
  - "What's my average engagement rate over the last year?" → must answer only
    within the real insights boundary from Task 13.2, and say what that is.
  - "How am I doing against competitors?" → must say the feature is off, not
    invent a benchmark from an empty pool.
- **Done means:** it answers the first from real rows, refuses the next three
  cleanly, and states its sample size unprompted.

---

## Stage 15 — MVP done

The MVP is finished when all of this is true and stays true without
intervention. **Note what is not on this list:** the weekly rollup,
Opportunities regeneration, competitor discovery, and Apify spend. Those were
the old definition of finished and they belonged to the ten-feature product.

- [ ] A daily sync lands the account's own posts, insights and comments
      without anyone opening a browser tab.
- [ ] The Instagram token refreshes itself before it expires, and `/settings`
      proves it — a silently failing refresh looks exactly like a working one
      until day 61.
- [ ] Supabase never pauses, because the keepalive writes daily.
- [ ] Every number on every page is either real or blank. No zeros standing in
      for absent data.
- [ ] The dashboard states its own coverage — how many posts have insights, and
      how far back they go.
- [ ] **The chat answers a question about the owner's account that a
      general-purpose chatbot could not**, from real rows, citing its sample
      size, and refuses cleanly when the data will not support the question.
- [ ] Recurring cost is $0 and `/settings` shows it.
- [ ] Navigation is three items.

**The honest bar, in one sentence:** the owner would rather open Trellis than
open Instagram Insights.

---

# PART IV — POST-MVP

**Nothing in this part is required to ship.** It is parked deliberately, and it
is written down so that parking it is a decision rather than a memory lapse.

---

## Stage 16 — Reinstating the flagged features

Each of these is a flag flip plus whatever it was missing when it was hidden.
Ordered by how ready they are.

### Task 16.1 — Calibrate before reinstating anything

- **Cannot start before roughly a month of real history exists.**
- **Steps:** re-argue every seed-tuned threshold in the table in
  `docs/cutover.md` — the "climbing" threshold, the viral-score floor, the
  topic noise floor, the opportunity sample floors, the comment window.
- **Notes:** each is a single constant chosen against invented data. The
  question for each is the same: _does this fire on things I actually care
  about, and stay quiet otherwise?_ Reinstating a feature whose thresholds
  were tuned against fiction is how a measurement product starts making claims
  its owner does not believe.

### Task 16.2 — Tracker, Audience, Calendar

- **Notes:** these run on Graph data that the MVP is already collecting, so
  they need calibration and nothing else. They are the cheapest to bring back
  and the most likely to be worth it.
- **Also revisit:** post analytics, tracker, followers and unfollows were
  folded from four tabs into four sections of one page. If any needs more room
  than a section gives it, promoting it back to a tab is a small change —
  decide it with a month of real data on screen.

### Task 16.3 — Opportunities and Weekly

- **Notes:** these are the two that were rebuilt correctly — SQL computes,
  Gemini interprets, code validates, result cached. They need sample floors
  met, which needs history, which needs Task 13.2's boundary to be favourable.
- **Bonus:** the validator work done in Task 14.3 for the chat and the
  validator these already use are the same machinery. Whichever is hardened
  second gets it for free.

### Task 16.4 — Hot Topics, rebuilt against spec 2.7

- **Blocker:** requires the 2.7 text, which is not in the repository.
- **Notes:** the current page measures hashtag share of things already posted.
  The spec asked for **generated concepts to explore, split by platform**.
  Different computation model, different subject matter — it is not a matter of
  wrapping the existing query in a generation call. It must follow the
  architecture the Opportunities correction established: SQL computes the
  evidence → Gemini interprets → code validates every number against the
  payload → the result is cached, with sample floors applied **before** the
  model call.
- **Status note:** this is the only feature that ever shipped something other
  than what was asked for. Hiding the tab makes it not urgent. It does not make
  it not true.

### Task 16.5 — Named unfollows, and the follower actor

- **Blockers:** two.
  1. `[CONFIRMED-UNKNOWN]` — whether `follows_and_unfollows` ever returns
     values for this account. See the register in Part V.
  2. The Apify cost, which has never been measured.
- **Steps when it comes back:**
  1. Pick a real followers actor in the Apify console and **read its Input
     tab**. `[UNVERIFIED-ASSUMPTION]`: `APIFY_FOLLOWERS_ACTOR` currently
     defaults to the _profile_ scraper, which is almost certainly wrong, and
     `resultsType: 'followers'` is an assumption of exactly the same class as
     the `username`/`usernames` bug that broke v1 in production.
  2. `npm run probe:apify-followers -- <handle> 20` — one small run, costs
     cents, reports the real per-1000 rate and projects a full snapshot.
- **This task decides the feature.** Three acceptable outcomes: keep it as
  built; degrade it to counts-only with no names; or cut it. What is not
  acceptable is leaving it in a state where it quietly spends the month's
  Apify credit.

### Task 16.6 — Competitors and Ideas

- **Blocker:** the compliance question in Task 17.3. These are the two features
  that make scraping load-bearing, and the decision about scraping is a
  commercial decision, not a technical one.

---

## Stage 17 — The commercial track

**The previous document's "finished" was a personal tool that runs itself
unattended. The actual goal is a commercial SaaS.** These three tasks are what
stands between the two, and the first of them is pure calendar time — which
means it should start early and run in parallel with everything in Part III,
not after it.

### Task 17.1 — Meta App Review and Advanced Access ★ **start early**

- **The gate:** Standard Access covers only accounts the developer owns —
  which is why the current setup works at all. **Serving any other user
  requires Advanced Access**, per permission.
- **Steps:**
  1. Business verification for the Meta app.
  2. A submission per permission — `instagram_basic`,
     `instagram_manage_insights`, `instagram_manage_comments`,
     `business_management`, and `instagram_content_publish` if publishing ships.
  3. Each submission needs a **screencast showing that permission being used in
     context** by a real, working product. You cannot record a screencast of a
     feature that does not exist.
- **Resources:** Meta App Dashboard → App Review → Permissions and Features;
  Meta Business Verification.
- **Notes, and this is the whole reason it appears this early in the document:
  it is calendar time you cannot compress.** Reviews take weeks and get
  rejected for presentation reasons as often as substantive ones. **It is the
  real gate to a first paying customer.** The dependency runs the other way
  from what feels natural: you need enough working product to film, but you
  should be filming the moment you have it rather than after everything else
  is polished.
- **Blockers:** needs the MVP working well enough to demonstrate. Not needed
  for the owner's own account, ever.

### Task 17.2 — Multi-tenancy

- **Steps:** `account_id` on every table, a users table, per-user Meta OAuth,
  per-user token storage, per-user token refresh, and per-user job scheduling.
- **Notes, stated plainly because it is the most expensive deferred decision in
  the project:** this was deliberately deferred, and **deferring it was a
  mistake whose cost grows.** It was a schema decision once. After the cutover
  it is a **migration against live data** — the same class of operation as the
  `drafts` → `calendar_entries` backfill that this document calls the one
  irreversible step in the project, except across every table at once.
  Deferring it further does not make it cheaper.
- **A specific open question it depends on:** see the `business_management`
  portfolio question in Part V. If that scope is required because of how this
  particular Page is owned rather than universally, other users' OAuth flows
  may need different scopes — and discovering that during a paid signup is
  much worse than discovering it now.
- **Also:** the current app has **no authentication of any kind**, by design,
  because it is a single-user tool at an obscure URL. Multi-tenancy is where
  that stops being acceptable, and `CRON_SECRET` stops being sufficient.

### Task 17.3 — The scraping compliance decision `[CONFIRMED-UNKNOWN]`

- **The situation:** Competitors, Ideas and Hot Topics run on Apify. The
  Instagram Graph API is deliberately first-party and **returns no competitor
  data by design** — there is no compliant API route to the data those features
  need. Scraping is against Instagram's Terms of Service.
- **Why it is tolerable now and not later:** in a personal tool it is one
  person's account and one person's risk. In a product being charged for it is
  a real liability, and **a plausible App Review failure** — Meta reviews the
  product, not just the permission.
- **Three named outcomes, and the document does not assume the first:**
  1. **Ship compliant-only** — drop competitor intelligence entirely. Costs
     three features and whatever differentiation they carried.
  2. **License a compliant data provider** — and price it in. Ends the $0
     model; the first real recurring cost.
  3. **Keep it and accept the risk** — with eyes open about what an
     enforcement action or a review rejection costs at that point.
- **Resolution method:** this is a business decision, not a probe. It should be
  made **before** Task 17.1's submissions, because what is on screen in a
  screencast is what Meta reviews.
- **Owner:** the account owner.

---

# PART V — THE OPEN QUESTIONS REGISTER

Every `[CONFIRMED-UNKNOWN]` in the project, with a resolution method and an
owner. **A question with no method attached is a worry; a question with one is
a task.** These exist as a separate part because the previous version of this
document's worst failure was answering one of them by assertion.

---

### Q1 — How far back do Graph insights actually go? ★

- **Why it matters:** it decides whether the chat reasons from twenty posts or
  two, and a grounded chat with two data points is not a product. Every
  decision in Stage 14 moves on this answer.
- **Evidence so far:** `[VERIFIED-LIVE]` a post dated `2026-03-29` returned
  full lifetime insights — reach 128, views 144, saved 1, shares 0, likes 3,
  comments 0, total_interactions 4. That is roughly five months. **One data
  point proving "never" wrong is not a boundary.**
- **Resolution method:** a standalone probe (Task 10.6) — read-only, importing
  nothing from the app's Graph code — that walks the media edge with pagination
  and requests insights at increasing post age. Report the oldest post that
  returns data and the first that does not.
- **Owner:** the account owner. They hold the token. Send back the terminal
  table, not the JSON.
- **What changes on the answer:** deep → add a backfill task and the chat has
  real history on day one. Shallow → the previous document's "expect
  sparseness" framing is roughly right, with a date instead of "never".

---

### Q2 — Does `follows_and_unfollows` ever return values for this account?

- **Evidence so far:** `[VERIFIED-LIVE]` the metric exists and the request is
  accepted. The response contains the breakdown **schema** —
  `{"breakdowns":[{"dimension_keys":["follow_type"]}]}` — with **no `results`
  array**.
- **Three candidate causes, none tested:**
  1. Genuinely zero follows and unfollows in the default ~2-day window.
     Plausible — `profile_views` was 8 that day.
  2. The `breakdown` and `metric_type` parameters need a different arrangement
     than the probe used.
  3. The metric is not populated for this account at all.
- **Resolution method:** re-request over a **30-day** window. Values appearing
  means cause 1 and the code is fine. An empty breakdown persisting across 30
  days means the free unfollows layer degrades to `followers_count` deltas
  only.
- **Owner:** the account owner.
- **What changes on the answer:** if it stays empty, the UI must **say gross
  follows and unfollows are unavailable** rather than rendering an empty
  breakdown as zeros — which is the blank-not-zero rule applied to a whole
  feature rather than a cell.
- **Priority:** low. This is a flagged-off feature under the MVP scope. It sits
  here so that it is an open item rather than a resolved detail.

---

### Q3 — Is `business_management` universally required, or required by how this Page is owned?

- **Evidence so far:** `[VERIFIED-LIVE]` the probe's `granular_scopes` show
  `pages_show_list` and `pages_read_engagement` **targeted at the Page id**,
  and `business_management` **with no target**. `[OWNER-STATED]` four business
  portfolios exist on the owner's account — `Kbeauty Klub`, `kbeauty_klub`,
  `Uzma Zaidi`, `znh_skinstore` — and none was connected to the Meta app.
- **Why it matters:** at multi-tenancy. If the scope is required because this
  Page sits inside a portfolio rather than universally, **other users' OAuth
  flows may need different scopes** — and discovering that during a paid
  signup is much worse than discovering it now.
- **Resolution method:** the first non-owner account to connect. Until then it
  is genuinely open. **Do not guess**, and do not write code that branches on
  a guess.
- **Owner:** deferred to Task 17.2.

---

### Q4 — Is `business_management` needed at runtime, or only at setup?

- **Evidence so far:** `[REPO-CONFIRMED]` the app never calls `/me/accounts`;
  it reads a configured `IG_USER_ID` directly. The scope is proven necessary
  for **discovering** the Page during setup and unproven for the ongoing
  insight reads.
- **Resolution method:** opportunistic. If a future token is ever generated
  without it and the reads still work, record that. It is not worth a
  deliberate experiment.
- **Decision regardless of the answer:** it goes in `REQUIRED_SCOPES`. Cost of
  requiring a scope you did not need: zero. Cost of a token regenerated without
  it: a setup you cannot repeat, presenting as an empty array.

---

### Q5 — Which API version should be pinned, and what breaks at the next bump?

- **Evidence so far:** `[VERIFIED-LIVE]` v21.0 requested, **v26.0 served**.
  `[REPO-CONFIRMED]` the version is hardcoded in `lib/publish/graph.ts` and
  defaulted in `scripts/probe-graph.ts`.
- **Resolution method:** pin deliberately (Task 10.4), surface the version on
  `/settings`, and re-run `probe:graph` after any deliberate bump. The
  per-metric retry path is the safety net and it has **never fired in
  production** — which means it is untested against the thing it was built for.
- **Owner:** whoever does Task 10.4.

---

### Q6 — Does `shortcode` appear on every media type?

- **Evidence so far:** `[VERIFIED-LIVE]` present on the newest post
  (`DcRHHmdiOTD`). The probe did not check one of each type.
- **Why it matters more than it looks:** `[REPO-CONFIRMED]`
  `lib/insights/graph.ts` **drops a media item entirely** when `shortcode`
  resolves to null. A type that omits it loses posts silently rather than
  storing them incomplete — a blank-not-zero violation at the row level.
- **Resolution method:** folded into Task 10.5 — make the probe inspect an item
  of each media type before declaring any field present or absent.
- **Blocked by:** `[VERIFIED-LIVE]` **no image posts exist** on the account.
  Image media cannot be probed until one is published, so this stays open by
  circumstance rather than by neglect.

---

### Q7 — Was a Supabase database password actually exposed?

- **Status:** `[UNVERIFIED-ASSUMPTION]`. The previous version of this document
  asserted it and scheduled a rotation. Nothing establishes it.
- **What is settled:** `[OWNER-STATED]` the **Meta app secret** was exposed and
  **has already been rotated**.
- **Resolution method:** the owner checks. Nobody else can.
- **Why it is not a free precaution:** rotating invalidates the connection
  string Vercel holds, and **production is down until Vercel is updated**. Do
  not recommend it on a mistaken premise, and if it is done, do it outside the
  cutover window.

---

### Q8 — Does Creator (rather than Business) restrict content publishing?

- **Status:** `[UNVERIFIED-ASSUMPTION]`. `[OWNER-STATED]` the account is
  Creator, linked to the Page; insights, media and comments all work.
- **Resolution method:** only observable the first time auto-publish runs.
- **What to do with it:** nothing now — publishing is off. But if auto-publish
  ever fails on a permissions error **despite** `instagram_content_publish`
  being granted, **switching Creator → Business is the first thing to try.**
  Recorded here because without it that failure looks like a scope problem.

---

# PART VI — WHAT WENT WRONG, PLAINLY

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

## Added since `c131042`

The eight above are preserved verbatim from the previous version, including
their ordering. These three are new, and the first two are worse than anything
on the original list.

9. **A confident sentence closed an open question.** "Graph insights do not
   backfill. Every post scraped under v1 has no reach data and never will."
   Written as settled fact, never checked, and wrong — a five-month-old post
   returned full insights on the first real probe. Cost: unquantifiable,
   because the damage of a false certainty is the questions nobody asks. It
   very nearly scoped the chat around two posts of history. _Lesson, and it is
   why every claim in this document now carries a tag: in a roadmap, the
   difference between "we believe" and "it is" is the difference between a
   thing someone will check and a thing nobody will._

10. **The product's core feature was built once, in v1, and then never
    revisited.** Ten analytics views got a stage each in v2; the chat got none,
    and its six tools still read v1's scraped tables. Cost: the MVP is now the
    last thing to be built rather than the first. _Lesson: the surface a person
    actually touches should lead the roadmap, not trail it. Building outward
    from what is easy to specify produces a lot of correct machinery pointed at
    nothing._

11. **Multi-tenancy was deferred as a schema decision and is now a data
    migration.** Cost: not yet paid, and growing. _Lesson: deferrals that get
    more expensive with time are not deferrals, they are loans. Write down the
    interest rate at the moment you take one out._

---

# PART VII — WHAT YOU HAVE YET TO DO

Everything below needs credentials, a dashboard login, or a decision.

### Already done ✅

- [x] Creator account confirmed, linked to the `Skincaring` Page.
- [x] Long-lived token in the local `.env`.
- [x] `npm run probe:graph` — 50/53, findings folded into this document.
- [x] Meta app secret rotated after exposure.

### Next — free, local, reversible

- [ ] **Write and run the insights-lookback probe** (Task 10.6). This is the
      highest-value item in the project and it unblocks the chat's design.
      Send back the terminal table.
- [ ] Re-request `follows_and_unfollows` over a 30-day window (Q2) — cheap to
      do while you have the token in hand, even though the feature is parked.
- [ ] Decide whether the Supabase password was actually exposed (Q7). If it
      was, rotate **now**, not during the cutover.

### Code work before the merge

- [ ] Seventh scope everywhere it is asserted (Task 10.3).
- [ ] Pin the API version and surface it on `/settings` (Task 10.4).
- [ ] Fix the probe's type-conditional false negative (Task 10.5).
- [ ] Feature flags; nav down to Dashboard · Chat · Settings (Stage 11).
- [ ] Sample floors on `summariseByFormat` (Task 11.4).

### The cutover window — one sitting, ~1 hour

- [ ] Pull the real `DATABASE_URL` from Supabase by hand — the local `.env`
      holds a placeholder.
- [ ] Manual Supabase dump; verify it is non-empty.
- [ ] Dry-run the migration until `verify:migration` prints **RECONCILED**.
- [ ] Merge → wait for deploy → migrate production → env vars → **redeploy**.
- [ ] **Rotate `CRON_SECRET`** — generate once, set in Vercel and in GitHub
      Actions. It cannot be read back, so it cannot be copied.
- [ ] `TRELLIS_URL` variable in GitHub Actions — the stable domain.
- [ ] `verify:cron-auth` → 20/20.
- [ ] `/settings`: seven scopes clean, version string right, flags off, $0.00.
- [ ] Confirm Deployment Protection is still off.

### First week

- [ ] Run **Scheduled jobs** manually with `daily` (not `weekly` — that feeds
      parked features).
- [ ] Confirm the Actions ticker is firing against the stable domain.
- [ ] Settle the insights boundary and, if history is deep, run the backfill.

### The MVP itself

- [ ] Rebuild the chat's tool surface over v2 tables (Task 14.2).
- [ ] Port the numeric validator into the chat, and **decide the streaming
      shape** — buffer-then-flush, or non-streaming final answer (Task 14.3).
- [ ] Thin-data honesty: decline single-format comparisons, always state the
      sample size (Task 14.4).
- [ ] Run the acceptance test — _"which of my posts held reach best after 48
      hours?"_ — plus the three questions designed to make it lie (Task 14.5).

### Decisions only you can make

- [ ] **Start Meta App Review early** (Task 17.1). It is pure calendar time and
      it is the real gate to a first paying customer.
- [ ] **The scraping compliance question** (Task 17.3) — compliant-only,
      licensed provider, or accept the risk. Decide it **before** the App
      Review submissions, because what is on screen is what Meta reviews.
- [ ] Supply the **spec 2.7 text** if Hot Topics is ever to be right.
- [ ] Decide when `ENABLE_IG_PUBLISHING` turns on — and watch the first
      auto-published post go out by hand before trusting it.

---

# APPENDIX A — THE ENVIRONMENT, AND ITS FOOTGUNS

All `[OWNER-STATED]`. These are facts about the working environment that are
invisible from the repository, and every one of them has already cost time.

### Vercel variables are Sensitive and cannot be un-marked

`vercel env pull` returns the literal string `[SENSITIVE]` for those values.
**The local `.env` therefore contains placeholders, not real values.** Any
local task needing `DATABASE_URL`, `GOOGLE_GENERATIVE_AI_API_KEY`,
`APIFY_TOKEN` or `CRON_SECRET` requires fetching them from source — Supabase,
AI Studio, the Apify console — and pasting them in by hand. `probe:graph`
worked only because the Meta token was entered manually.

### `CRON_SECRET` already exists in Vercel and is unreadable

It must be **rotated in both places** during the cutover, not copied. Any
instruction that says "add `CRON_SECRET`" is wrong.

### The environment is split across two machines

Meta and browser work happens on a **Mac**; the repository, `.env` and all
probe scripts live on a **Windows laptop** under
`~/Documents/Projects/trellis`, running Git Bash. Any instruction that assumes
one machine is wrong. **The token has to be transported between them and is a
credential in transit** — not pasted into anything that keeps a history.

### `pkill -f "next start"` does not kill the dev server

The process is `next-server`. This has already cost two rounds of testing
stale code, which presents as a fix that did not work. **`fuser -k 3000/tcp`
works.**

### `/settings` is the source of truth for configuration

It renders resolved values from the running function and has repeatedly proved
more reliable than the Vercel dashboard for confirming a variable change took
effect. Everything added to the config surface — flags, API version — should
appear there for this reason.

---

# APPENDIX B — RESOURCE INDEX

| Thing                                         | Where                                                       |
| --------------------------------------------- | ----------------------------------------------------------- |
| Deployment, env vars, cron, protection        | Vercel → Project → Settings                                 |
| Database, pooler string, password reset, logs | Supabase → Project Settings → Database                      |
| Manual backups (no automated ones on Free)    | Supabase CLI `supabase db dump`, or `pg_dump`               |
| Repository secrets and variables              | GitHub → Settings → Secrets and variables → Actions         |
| The schedules and the queue ticker            | `.github/workflows/scheduled-jobs.yml`, `pipeline-tick.yml` |
| Vercel's two daily crons                      | `vercel.json`                                               |
| Token generation and scopes                   | `docs/instagram-setup.md`, Meta Graph API Explorer          |
| Token inspection                              | Meta Access Token Debugger, and `/settings`                 |
| App Review and business verification          | Meta App Dashboard → App Review                             |
| Actor input schemas and spend (post-MVP)      | Apify console → Store → Input; → Billing → Usage            |
| Model key and free-tier limits                | Google AI Studio                                            |
| The mechanical cutover checklist              | `docs/cutover.md`                                           |
| Seed-tuned thresholds, with current values    | `docs/cutover.md`                                           |
| Code-level history, bugs and decisions        | `NOTES.md`                                                  |
| The chat's current tools                      | `lib/chat/tools.ts`, `lib/prompts/chat-system.v1.ts`        |
| The numeric validator to port                 | `lib/generate/validate.ts`                                  |
| Migration verification                        | `npm run verify:migration`                                  |
| Cron auth verification                        | `npm run verify:cron-auth`                                  |
| Graph API probe                               | `npm run probe:graph`                                       |
| Apify follower cost probe (post-MVP)          | `npm run probe:apify-followers`                             |
