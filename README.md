# Trellis

An Instagram coach that shows its work. Benchmarks your posts against your
niche, names the one gap worth fixing, and drafts the content to close it —
with the receipts behind every claim. Single account, no login, $0/month.

Cloud-hosted: **Vercel** (hosting + functions + cron) and **Supabase**
(Postgres, free tier). There is no local server and no desktop process — the
whole thing runs as HTTP functions and a resumable jobs table.

## Where this is

**Stage 1 of 8 is built**: schema, jobs infrastructure, and the daily
keepalive cron. See [`AGENTS.md`](AGENTS.md) for the full spec and build
order, and [`NOTES.md`](NOTES.md) for the migration log, deviations, and
what's verified so far. Everything past Stage 1 (the scan pipeline, analysis
engine, drafts, chat, scheduling) lands in the stages that follow, each
gated on its own tests and a manual smoke test before the next one starts.

An earlier local-first version of this project (SQLite, Ollama, a desktop
worker process) lives in [`legacy/`](legacy/) for reference. It is not part
of the build — see the migration note in `NOTES.md` for why.

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
  hook classification, gap analysis, voice profile, drafts, chat). There is
  no local model tier in a serverless deployment.
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
