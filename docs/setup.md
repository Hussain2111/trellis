# Setup

Local-first, single user, `$0/month`. Everything runs on your machine except two
free-tier HTTP APIs.

## 0. Before you start — machine settings that actually matter

You are running inference on a 15W U-series chip with no discrete GPU. Sustained
load will thermally throttle it, and a throttled run can be half the speed of a
cold one.

- **Plug the laptop in.** Battery mode caps the package power budget.
- **Set Windows to the "Best performance" power mode** (Settings → System →
  Power & battery → Power mode).
- **Close what you can** before a long job. Windows takes ~4 GB, and the dev
  server plus a browser take 2–3 GB more. That leaves roughly 8 GB for a model
  — a 7–8B at Q4 is the ceiling, and a 4B is the comfortable default.

Long jobs (transcription, embedding the corpus) run through the job queue and
checkpoint as they go, so it is safe to close the laptop and come back.

## 1. Install

```bash
npm install
cp .env.example .env.local
npm run db:migrate
```

## 2. Ollama

Ollama is already installed. Pull the embedding model — this one is not optional,
it is the workhorse of the whole analysis layer:

```bash
ollama pull nomic-embed-text
```

Then pull one or two generation candidates to benchmark. Check
<https://ollama.com/library> for current tags first; they churn fast and any name
written down here may already be stale.

```bash
ollama pull qwen3:4b
ollama pull gemma3:4b
```

## 3. Benchmark — do this before choosing anything

```bash
npm run bench:llm
```

This measures what your machine actually does: prefill (prompt-eval) tok/s,
generation tok/s, and time-to-first-token at three prompt sizes, plus embedding
throughput. It writes the results into `NOTES.md` and recommends a model.

Set the winner in `.env.local`:

```
OLLAMA_MODEL=qwen3:4b
```

**Read the prefill number.** It is the one that matters. Generation speed decides
how long an answer takes to finish; prefill decides how long you wait before it
*starts*, and on this hardware a 2,000-token prompt can cost minutes before the
first token. That is why `TIER_B_MAX_PROMPT_TOKENS` exists and why all
long-context reasoning goes to the cloud tier.

### If it's too slow

Try these in order, and record what happened in `NOTES.md`:

1. **Ollama's built-in Vulkan backend.** Recent builds reach Iris Xe without a
   separate toolchain. This is a config change, not an install — try it first.
2. **CPU-only.** The baseline. Slower, but zero setup risk, and honestly fine
   for what Tier B is asked to do (embeddings and short constrained calls).
3. **IPEX-LLM's Ollama Portable Zip.** Intel's SYCL-backed fork; can offload all
   layers to the iGPU with `OLLAMA_NUM_GPU=999`. Potentially fastest, but
   real-world reports on Iris Xe involve missing oneAPI DLLs and SPIR-V version
   errors that need a graphics-driver update. Only attempt this if 1 and 2 are
   both too slow, and give yourself a time limit.

## 4. Google AI Studio key (Tier A)

Get a free key at <https://aistudio.google.com/apikey>. No credit card, which is
what makes it genuinely unable to bill you.

```
GOOGLE_GENERATIVE_AI_API_KEY=...
```

**One thing to know before you use it:** Google's free tier permits them to use
your prompts to improve their products. Your captions are already public, so
that is probably fine for analysis. Your voice profile and chat history are not
public — if you would rather those never leave the machine, set
`LOCAL_ONLY_VOICE_AND_CHAT=true` (or flip the switch in Settings). The writing
will be noticeably worse; that is the trade.

## 5. Apify token (from M1)

Free plan, ~$5/month of credits ≈ 3,300 posts. Verify the current terms when you
sign up — they move.

```
APIFY_TOKEN=...
SCRAPE_MODE=fixture
```

Leave `SCRAPE_MODE=fixture` while developing. The first successful live scrape is
written to `./fixtures/`, and fixture mode replays the whole pipeline offline at
zero credit cost. You will iterate on the analysis dozens of times and should not
pay for it each time.

## 6. Run it

```bash
npm run dev
```

Starts two processes: the Next dev server on <http://localhost:3000> and the job
worker. Both are needed — the worker is what actually runs scans, transcription,
embedding and analysis, and keeping it separate is why the UI never freezes
behind a four-minute model call.

There is no login. The first route is the dashboard.

## 7. Later milestones

- **Transcription (M2)** needs a `whisper.cpp` binary and a `base.en` model.
  Point `WHISPER_BIN` and `WHISPER_MODEL_PATH` at them. If they are missing the
  app degrades to caption-only analysis and says so in the UI.
- **Publishing (M11)** needs a Meta app and a linked Facebook Page. That gets its
  own document, `docs/instagram-setup.md`, written before the code.

## Cost check

Settings shows a month-to-date total. It should read `$0.00`. If it doesn't,
something instantiated a billable provider — which shouldn't be possible while
`ALLOW_PAID_PROVIDERS=false`, since that makes the attempt throw at startup and
name the provider.
