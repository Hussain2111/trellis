# Trellis

An Instagram coach that shows its work. Benchmarks your posts against your niche,
names the one gap worth fixing, and drafts the content to close it — with the
receipts behind every claim. Runs locally, costs nothing.

Single user, single account, no login. `npm run dev` and the first route is the
dashboard.

All eleven milestones are built. The whole pipeline runs offline against fakes —
`npm run seed:demo` proves it with no network, no credits and no API keys.
See [`docs/setup.md`](docs/setup.md) to run it on your own data and
[`NOTES.md`](NOTES.md) for measurements, deviations, and what has not yet
touched a real service.

## The two constraints everything else follows from

1. **$0/month.** Every provider declares `costsMoney`. With
   `ALLOW_PAID_PROVIDERS=false` (the default), instantiating a billable one
   throws at startup and names it — there is no silent fallback to a paid API.
   Settings shows a month-to-date total that should read `$0.00`.
2. **A fanless ultrabook with no discrete GPU.** ~8 GB of usable RAM for a model
   and single-digit tok/s prefill. Prompt evaluation, not generation, is the
   bottleneck — so local prompts are capped and long-context reasoning goes to a
   free cloud tier.

## How it's put together

**Two model tiers, both free.**

- **Tier B — local (Ollama).** Embeddings, short constrained classification,
  emergency chat fallback. Hard-capped at `TIER_B_MAX_PROMPT_TOKENS`; the router
  throws on an oversized prompt rather than spending four minutes in prefill.
- **Tier A — Google AI Studio free tier.** All long-context reasoning: cluster
  naming, gap analysis, voice profile, drafts, chat. Rationed by a daily budget
  per job type, and chat yields first when the day runs short.

Every generated artifact records `generated_by`, so you can always see which
model wrote what.

**The analysis engine pushes work downhill.**

- **Layer A — plain TypeScript.** Medians, follower-normalised engagement,
  outlier detection, cadence, decay. No model involved, and it does more of the
  work than people expect.
- **Layer B — embed, cluster, name once.** Every post is embedded locally, then
  clustered in TypeScript; a *single* Tier A call names the clusters. New posts
  are assigned by proximity with no model call at all. Archetypes come from your
  actual corpus rather than a model's idea of what categories should exist.
- **Layer C — one Tier A call** over the compact aggregates, never the corpus.
  Five patterns and one gap, each with its numbers and its `post_ids`, validated
  back against Layer A before it's stored.

**Nothing blocks on a model call.** Long operations are rows in a `jobs` table
with checkpoints and visible progress, run by a separate worker process. On this
machine, long jobs *will* be interrupted; they resume.

## Commands

| | |
|---|---|
| `npm run dev` | Web + worker |
| `npm run bench:llm` | Measure this machine, pick the local model, write `NOTES.md` |
| `npm run seed:demo` | Run the entire pipeline on synthetic data, offline, free |
| `npm run db:migrate` | Apply migrations |
| `npm run db:generate` | Generate a migration after a schema change |
| `npm test` | Tests on the deterministic layer |
| `npm run typecheck` | `tsc --noEmit` |

## The pipeline

Scan → features → transcribe → embed → cluster → name → analyse → voice →
draft → render → schedule → publish.

Everything up to `analyse` is free and local. Only four steps ever spend the
rationed cloud tier: naming the archetypes (one call), the gap analysis (one
call), the voice profile (one call), and drafts (three or four per call).

## Two things worth knowing before you start

**Run the benchmark first.** `npm run bench:llm` measures what your machine
actually does and writes the numbers into `NOTES.md`. Prefill speed — not
generation — is what decides everything about how this is configured.

**Leave `SCRAPE_MODE=fixture` while you're poking at it.** The first live scrape
of an account is saved to `./fixtures/`, and fixture mode replays it forever at
zero credit cost. Apify credits are the only genuinely finite resource here.
