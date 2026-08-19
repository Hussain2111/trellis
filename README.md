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

Task 0 (the removals and the `drafts`+`schedule` → `calendar_entries`
migration) has landed. The Graph API insights layer and the new analytics
views have not. See [`NOTES.md`](NOTES.md) for the migration log, real bugs
found in production, and deliberate deviations.

An earlier local-first version of this project (SQLite, Ollama, a desktop
worker process) lives in [`legacy/`](legacy/) for reference. It is not part
of the build — see the migration note in `NOTES.md` for why.

## Pages

One field on the dashboard — an Instagram handle — kicks off the entire
pipeline; everything downstream runs automatically and lands on its own page:

| Route          | Shows                                                            |
| -------------- | ---------------------------------------------------------------- |
| `/`            | Account summary, recent jobs                                     |
| `/competitors` | The auto-discovered competitor pool and its sample-size warning  |
| `/calendar`    | Your hand-written posting plan, due/overdue in Riyadh local time |
| `/chat`        | A coach grounded in everything above, via read-only tools        |
| `/settings`    | The $0.00 cost check, provider config, recent calls              |

`/posts` still renders the scraped back catalogue but is off the nav until
the Graph-API-sourced analytics views replace it.

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

## How it's put together

- **Database** — Supabase Postgres via Drizzle (`drizzle-orm/postgres-js`),
  connected through Supabase's pooler (transaction mode) so many concurrent
  Vercel function invocations don't exhaust Postgres's connection limit.
- **Model provider** — Gemini free tier for every LLM call (niche inference,
  hook classification, phrasing pattern claims, chat). There is no local
  model tier in a serverless deployment.
- **Scraping** — Apify's Instagram profile-posts actor, fixture-first. Set
  `SCRAPE_MODE=fixture` while developing so nothing spends real Apify credit;
  the first live scrape is captured to `./fixtures/` for replay.
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
