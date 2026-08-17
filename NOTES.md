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

## Deviations from the spec

- **`eslint-config-next` ships a native flat-config export** in the
  installed version (16.3.1) — `eslint-config-next/core-web-vitals` is
  already an ESLint 9 flat-config array. The `@eslint/eslintrc`
  `FlatCompat` shim (the documented approach for older Next versions)
  throws `Converting circular structure to JSON` against this version, so
  `eslint.config.mjs` imports the flat exports directly instead.
- **Job `checkpoint`/`progress` plumbing exists but nothing exercises it
  yet.** The `noop` handler and `runTick()`'s time budget are typechecked
  and manually smoke-tested (see above), but real checkpoint/resume
  behavior — the actual reason this table exists — only gets a real test
  once Stage 2 registers a handler that can plausibly run past a function's
  time budget.
- **No handler is registered for most `JobType`s yet.** `lib/jobs/registry.ts`
  and `lib/jobs/types.ts` declare the full job-type surface up front (so the
  schema doesn't reshape later), but only `noop` has an implementation.
  `runTick()` will `fail()` any other type permanently right now — expected
  until each stage adds its handler.

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
- **Apify, Gemini.** No live call to either yet — Stage 2 (scan pipeline)
  and Stage 4 (analysis engine) are fixture-first per the spec, and neither
  has started.
