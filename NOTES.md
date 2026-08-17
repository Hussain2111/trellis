# NOTES

Running log of measurements, drift, and quirks. Every sizing decision in this
build should point at something in here rather than at an estimate.

---

## M0 benchmark — measured on this machine

<!-- BENCH:START -->

_Not run yet._ There is no Ollama instance in the environment this scaffold was
built in, so the table below is empty by design — it must be filled by running
the benchmark on the actual laptop:

```
npm run bench:llm
```

The script writes its results back into this block. It measures, per model:
prefill (prompt-eval) tok/s at 200 / 800 / 2,000-token prompts, generation
tok/s, and time-to-first-token — plus `nomic-embed-text` throughput in texts/s,
extrapolated to a 1,100-post corpus.

**Nothing downstream is settled until this has run.** In particular:

- `OLLAMA_MODEL` should be whatever the benchmark says is usable, not a guess.
- `TIER_B_MAX_PROMPT_TOKENS` (default 800) should be re-derived from the
  measured prefill rate: pick a ceiling whose prefill time is tolerable, which
  is roughly `acceptable_seconds × prefill_tok_s`.
- Whether the Vulkan / IPEX-LLM detour in §1 is worth attempting depends
  entirely on the CPU-only baseline number.

<!-- BENCH:END -->

### Acceleration ladder — status

| Step | Status | Notes |
|---|---|---|
| 1. Ollama built-in Vulkan | untested | Config change, not an install. Try first. |
| 2. Ollama CPU-only | untested | The baseline. Zero setup risk. |
| 3. IPEX-LLM Ollama Portable Zip | not attempted | Only if 1 and 2 are too slow, and timeboxed. Known to hit missing oneAPI DLLs and SPIR-V version errors on Iris Xe. |

Record the measured numbers for each step you actually try, so the decision is
on the record rather than in someone's memory.

---

## Deviations from the spec

Reality beats the spec, but the deviations get written down.

- **`ollama-ai-provider` → `ollama-ai-provider-v2`.** The package named in §4 is
  built against AI SDK v3/v4 and does not work with `ai@7`. `ollama-ai-provider-v2`
  declares `ai: ^7.0.0` as a peer and is the maintained line. Same interface.
- **`server-only` is not used to guard `lib/env.ts`.** That package throws when
  imported from a plain Node process, which would break the worker and the
  benchmark. A `typeof window` check does the same job in both environments.
- **shadcn/ui components are hand-written, not scaffolded.** `shadcn init` wants
  network access and an interactive prompt, and its defaults are the white
  card-on-grey look §14 explicitly rules out. `components/ui/primitives.tsx` is
  shadcn-*shaped* (cva variants, `cn`, plain elements) so `shadcn add` can drop
  real components in later without a rewrite.
- **`frontend-design` skill was unavailable** in the environment this was built
  in. Direction chosen deliberately instead — see below.
- **`archiver` v8 is ESM and exports classes, not a factory.** `archiver('zip')`
  is dead; it is `new ZipArchive(...)`.
- **satori cannot use the UI's fonts.** It reads TTF/OTF/WOFF only — not WOFF2,
  and not variable axes — while `@fontsource-variable/*` ships variable WOFF2
  exclusively. The static `@fontsource/*` siblings are installed purely to give
  the slide renderer real outlines. Both are local; nothing is fetched.
- **Server Components cannot pass closures to Client Components.** Every
  `ActionButton` takes a server action pre-bound with `.bind(null, …)`. An
  `action={() => doThing(id)}` wrapper compiles fine and fails at runtime with
  "Functions cannot be passed directly to Client Components".
- **satori counts adjacent JSX text nodes as separate children.** `@{handle}`
  is two children and needs an explicit `display`, which is a confusing error to
  read. Use a single template literal.

---

## Design direction

Recorded so later milestones hold the same line rather than drifting toward
default shadcn.

**"Instrument panel."** Dark only — this is a personal cockpit, not a site.

- Near-black canvas (`#0a0b0d`), panels a step lighter (`#101216`), hairline
  1px borders (`#1f232a`). No shadows, no rounded-2xl cards.
- **Every number, handle, metric label and delta is set in mono**
  (JetBrains Mono Variable); prose is Inter. That one rule carries the identity:
  the coach is numerate, so the typography says so.
- Amber (`#ffb020`) is reserved for *the thing that matters right now* — the
  gap, the headline delta, an in-flight job. If amber is everywhere it stops
  meaning anything.
- Green/red only for state that is genuinely good or bad (free vs billable,
  ok vs failed), never for decoration.
- Dense: 13px body, 8px vertical rhythm in tables, stats as label-over-number.

---

## Apify schema drift

_Nothing yet — no live scrape has run._ When one does: record the actor
id, the input fields that actually worked, and any field that moved or
disappeared, with the date. `posts.raw` keeps the untouched payload so
re-normalisation never costs another scrape.

---

## Observed free-tier limits

_Nothing yet._ Record what the provider actually did, not what the docs said:

| Date | Provider | What was observed | Source |
|---|---|---|---|
| | | | |

Published Gemini Flash free-tier figures ranged from ~20 to ~1,500 requests/day
depending on source and month at the time of writing, which is exactly why
nothing is hardcoded. `quota_budget.observed_limit` persists what we learn from
rate-limit headers; 429s are classified into per-minute (back off) vs daily
(queue and tell the user).

---

## Local-model quirks

_Nothing observed yet — the local tier has not been run against real Ollama in
this environment._ Expected candidates, to confirm on the laptop: JSON mode
ignoring enum constraints, repeated near-duplicate cluster names, silent
truncation at `num_predict`.

---

## Verified offline

`npm run seed:demo` builds a synthetic corpus and runs the entire pipeline with
no network, no credits and no API keys — the fakes stand in for every provider.
Last run:

| stage | result |
|---|---|
| posts | 1,100 (1 self + 6 competitors) |
| features | 1,100 |
| embeddings | 1,100 |
| archetypes | 8, k chosen by silhouette |
| labels | 1,100 |
| analysis | 5 patterns + 1 gap, all claims reconciled |
| drafts | generated, schema-valid |
| slides | rendered to PNG via satori + resvg |

Clustering demonstrably recovers the structure in the synthetic data: each hook
family lands in its own stable archetype, which is the property the "51% vs your
20%" style of claim depends on.

Two real bugs surfaced only because this ran end to end:

- The fake scraper truncated handles to four characters when building
  shortcodes, so every competitor collided on the unique index and 800 of 1,100
  posts silently vanished.
- The fake LLM's schema sampler satisfied the *shape* of a zod schema but not
  its constraints, so `.length(5)` and `min(50)` fields failed validation and
  both the gap analysis and voice profile produced nothing. It now generates
  from `z.toJSONSchema`, which sees the constraints.

Both were fakes rather than production code, which is exactly the argument for
having the offline path be a first-class thing that actually runs.

---

## Not yet exercised against reality

Everything below is written and typechecked but has never touched the real
service. Treat first contact as a debugging session, and record what moved.

- **Apify.** Actor input schema and field names are best-effort from
  documentation. `posts.raw` keeps the untouched payload precisely so
  re-normalisation after drift costs nothing.
- **Google AI Studio.** Model ids, structured-output behaviour, and whether any
  usable rate-limit headers come back at all.
- **Ollama.** No instance in the build environment. The benchmark, embeddings
  and local generation are all unmeasured.
- **whisper.cpp + ffmpeg.** Neither binary was present; the transcription queue
  correctly skipped and said so, which is the degraded path working, not the
  happy one.
- **Instagram Graph API and cloudflared.** Written against the documented
  container flow; see `docs/instagram-setup.md`.
