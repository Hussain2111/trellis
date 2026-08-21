# Trellis

An Instagram coach that shows its work. Pulls your own account's numbers from
the Instagram Graph API, benchmarks them against a scraped competitor pool,
and shows the receipts behind every claim. Single account, no login, $0/month.

Cloud-hosted: **Vercel** (hosting + functions + cron) and **Supabase**
(Postgres, free tier). There is no local server and no desktop process — the
whole thing runs as HTTP functions and a resumable jobs table.

## Where this is

v1 shipped and ran against real infrastructure. **v2 is in progress**: it
drops the generative half of the product (draft generation, slide rendering,
the voice profile, the single-headline-gap framing) in favour of measurement
— the account's own analytics, straight from the Graph API. Apify is now
only used for competitors and niche discovery.

v2 is complete: the removals, the `drafts`+`schedule` → `calendar_entries`
migration, the Graph API insights layer, and all ten analytics views. It has
not been deployed — `main` still runs v1. See
[`docs/roadmap.md`](docs/roadmap.md) for where the project stands as an
operated system and what is left to do,
[`docs/cutover.md`](docs/cutover.md) for the mechanical steps, and
[`NOTES.md`](NOTES.md) for the migration log, real bugs found in production,
and deliberate deviations.

An earlier local-first version of this project (SQLite, Ollama, a desktop
worker process) lives in [`legacy/`](legacy/) for reference. It is not part
of the build — see the migration note in `NOTES.md` for why.

## Pages

One field on the dashboard — an Instagram handle — kicks off the entire
pipeline; everything downstream runs automatically and lands on its own page:

| Route            | Shows                                                            |
| ---------------- | ---------------------------------------------------------------- |
| `/`              | Account summary, recent jobs                                     |
| `/weekly`        | This week against last, Monday–Sunday Riyadh                     |
| `/analytics`     | Every post's reach, saves, shares and engagement                 |
| `/tracker`       | Reach at 24h / 48h / 7d — what's still climbing                  |
| `/audience`      | Who actually comments, over a rolling 90 days                    |
| `/unfollows`     | Daily follower counts, and who left (paid, on demand)            |
| `/opportunities` | Ranked gaps, each with the numbers and post ids behind it        |
| `/ideas`         | Niche posts that beat their own account's baseline hardest       |
| `/topics`        | Hashtags gaining share in your niche                             |
| `/competitors`   | The pool, with add-by-handle and per-account rescan              |
| `/calendar`      | Your hand-written posting plan, due/overdue in Riyadh local time |
| `/chat`          | A coach grounded in everything above, via read-only tools        |
| `/settings`      | The $0.00 cost check, Apify budget, Graph token scopes           |

`/posts` still renders the scraped back catalogue but is off the nav —
`/analytics` supersedes it.

## The constraints everything else follows from

1. **$0/month.** Every provider declares `costsMoney`. With
   `ALLOW_PAID_PROVIDERS=false` (the default), instantiating a billable one
   throws at startup and names it — there is no silent fallback to a paid API.
2. **No auth.** This is a personal dashboard for one Instagram account,
   reachable only by the person running it. No login, no sessions, no user
   model — see `AGENTS.md`.
3. **Vercel Hobby's function-duration ceiling.** Nothing blocks on a
   multi-minute scrape or a model call. Long operations are rows in a `jobs`
   table with checkpoints; a webhook or a short cron/API tick advances them
   one step at a time.
4. **No fabricated metrics.** A number that isn't known renders as a blank,
   never a zero and never a guess. Insights only exist for Graph-sourced posts
   inside Meta's lookback, so most views are partly null by nature — every
   such cell goes through one component, and each view says at the top how
   much of it is actually measured.

## How it's put together

- **Database** — Supabase Postgres via Drizzle (`drizzle-orm/postgres-js`),
  connected through Supabase's pooler (transaction mode) so many concurrent
  Vercel function invocations don't exhaust Postgres's connection limit.
- **Model provider** — Gemini free tier for every LLM call (niche inference,
  hook classification, phrasing pattern claims, chat). There is no local
  model tier in a serverless deployment.
- **Your own data** — the Instagram Graph API, free: posts, per-post insights
  (reach, saves, shares, views), comments, and daily follower counts. Requires
  `IG_USER_ID` / `IG_ACCESS_TOKEN` carrying all six scopes listed in
  [`docs/instagram-setup.md`](docs/instagram-setup.md); `/settings` names any
  that are missing. Migrating from v1? Follow
  [`docs/cutover.md`](docs/cutover.md) — the order matters.
- **Competitor data** — Apify, and only for competitors and niche discovery.
  Set `SCRAPE_MODE=fixture` while developing so nothing spends real credit.
  Every scrape is budgeted against `APIFY_MONTHLY_CREDIT_USD` and refused
  rather than truncated when the month runs dry.
- **Jobs** — `lib/jobs/queue.ts` claims work with Postgres `FOR UPDATE SKIP
LOCKED`, so a cron tick and a webhook landing at the same moment can't
  double-claim a row. `lib/jobs/runner.ts` runs a time-boxed `runTick()` —
  never an infinite loop — appropriate for a function with a wall-clock
  ceiling.
- **Keepalive** — `/api/cron/keepalive`, on a daily Vercel Cron schedule,
  does a real write against Postgres so a free Supabase project (which
  pauses after 7 days idle) never goes to sleep.
- **Scheduling** — Vercel Hobby cron is capped at once a day per entry, which
  is far too slow to drive a job chain. The real scheduler is a GitHub
  Actions workflow hitting `/api/jobs/tick` every 10 minutes, authenticated
  with `CRON_SECRET`.
- **Publishing** — the Instagram Graph API, free under Standard Access for a
  self-owned account. Off by default (`ENABLE_IG_PUBLISHING=false`), because
  the intended workflow is copy → paste → post by hand — see
  [`docs/instagram-setup.md`](docs/instagram-setup.md) to turn it on.

## Commands

|                       |                                            |
| --------------------- | ------------------------------------------ |
| `npm run dev`         | Next dev server                            |
| `npm run db:generate` | Generate a migration after a schema change |
| `npm run db:migrate`  | Apply migrations                           |
| `npm test`            | Unit tests                                 |
| `npm run typecheck`   | `tsc --noEmit`                             |
| `npm run lint`        | ESLint                                     |
| `npm run format`      | Prettier, write                            |

## Local development

```bash
npm install
cp .env.example .env.local
# point DATABASE_URL at a local Postgres, or a Supabase project
npm run db:migrate
npm run dev
```

There is no login. The first route is the dashboard.
