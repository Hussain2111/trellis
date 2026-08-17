# Trellis

An Instagram coach that shows its work. Benchmarks your posts against your niche,
names the one gap worth fixing, and drafts the content to close it — with the
receipts behind every claim. Runs locally, costs nothing.

Single user, single account, no login. `npm run dev` and the first route is the
dashboard.

**Status: M0 (scaffold).** See [`docs/setup.md`](docs/setup.md) to run it and
[`NOTES.md`](NOTES.md) for measurements and deviations.

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
| `npm run db:migrate` | Apply migrations |
| `npm run db:generate` | Generate a migration after a schema change |
| `npm test` | Tests on the deterministic layer |
| `npm run typecheck` | `tsc --noEmit` |

## Milestones

`M0` scaffold · `M1` ingest · `M2` features + transcription · `M3` competitors ·
`M4` clustering · `M5` gap analysis · `M6` voice · `M7` drafts · `M8` chat ·
`M9` slides · `M10` scheduling · `M11` publishing

Each one stands alone. Routes for later milestones exist in the nav and say which
milestone fills them in, rather than pretending to work.
