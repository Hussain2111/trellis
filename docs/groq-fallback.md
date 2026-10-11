# Resilient chat with Groq

Integrated latest `main`, including merged PR #4 at `b1dddd16`, into the
existing `fix/groq-resilient-chat` branch on 2026-10-11. Merge conflicts in
`app/api/chat/route.ts` and `lib/api/respond.ts` were resolved by combining
PR #4's performance/correlation hooks with PR #5's safe error/failover behavior.
The performance modules, SQL timing proxy and deletion fixes remain as in main.

## Manual environment configuration

Keep your existing `MODEL_PRIMARY` and Google key. Set:

```env
MODEL_FALLBACK=groq:openai/gpt-oss-120b
```

Set `GROQ_API_KEY` securely in the intended hosting environment. No production
settings or secrets were changed. Without a Groq key, the existing resolver
omits that lane and Gemini continues alone. Without any buildable lane, chat
returns a safe unavailable response. Local keys belong in ignored env files.

Set optional `GROQ_CALLS_PER_MINUTE` and `GROQ_CALLS_PER_DAY` to the request
limits shown for your model/project in the Groq console. Blank values retain
`MODEL_CALLS_PER_MINUTE` / `MODEL_CALLS_PER_DAY` as conservative caps, while
usage counters remain separate. No Groq quota values are assumed in code.
A missing key is configuration work, not a reason to insert a placeholder key.

[Groq's model documentation](https://console.groq.com/docs/model/openai/gpt-oss-120b)
was checked on 2026-10-11: it lists this model and tool use through Chat
Completions. The locked `@ai-sdk/openai-compatible` adapter is exercised with
mocked HTTP tool calls; no live inference or account-specific model access was
verified. Provider availability/permissions can change.

## Reused behavior and failure policy

The OpenAI-compatible provider registry, provider-scoped SQL ledger, existing
read-only chat tools, conversation history, final answering step, metadata
step/response diagnostics, and numerical validator are reused. No new dependency,
service, schema, metric interpretation, or Instagram data mutation is introduced.

Only `APICallError.isInstance` transport errors qualify for failover:

| Failure                                                | Behavior                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| Local request guard denies a lane                      | Skip it; check the other provider's own ledger/caps             |
| HTTP 429                                               | Record failed calls, honor Retry-After, consider secondary lane |
| HTTP 502 / 503 / 504                                   | Record failed calls, consider secondary lane                    |
| No HTTP status, SDK `isRetryable`                      | Consider secondary lane (SDK-wrapped network error)             |
| HTTP 401 / 403                                         | Stop; no retry or failover                                      |
| HTTP 400 / 404 / 422                                   | Stop; invalid request/model configuration                       |
| HTTP 500 or other transport error                      | Stop; no blanket failover                                       |
| Tool, application, validation or persistence exception | Stop; no provider failover                                      |

Every lane is visited once, with `maxRetries: 0`. Existing same-provider fallback
exclusion prevents a second lane sharing the primary's quota. SDK tool-error
results stop the turn before another request/answer. Raw exception text is not
returned by this chat route, persisted in its model-run error field, or logged
by its error wrapper; the run retains the failure category and provider metadata.

Both lanes receive the same system prompt, history, current question and tool
surface. A new lane queries its own evidence; partial text/evidence from a failed
lane is not treated as a completed answer. The existing validator still removes
unsupported numerical sentences. Provider capacity errors never become missing
Instagram-data claims.

Successful runs record total input/output tokens across every tool-loop step;
failed attempts record the actual call-start count. Successful provider usage is written before validation/conversation persistence
and outside the generation/failover catch. `model_runs.status=ok` denotes model
generation success, not successful chat storage. If saving the completed turn
fails, usage remains counted once, a safe `chat_persistence_failed` response
restores the question, and a metadata-only `[chat.persistence]` diagnostic records
`generationOutcome:ok` and `persistenceOutcome:error` with the request correlation
ID. Both ledger writes and turn storage retain the persistence timing stage.
No second error run or fallback model call is generated for a save failure.
If the ledger itself cannot be written, the request stops before saving the
conversation; a database outage can still prevent durable quota accounting.

The question and validated
answer are saved in one database transaction after success. History uses the
message ID to break equal-timestamp ties. A provider failure saves neither side
of the turn; the client restores the question and removes the optimistic bubble
on any failed response/network request. Thread titles are preserved when set.

## Limits and follow-up

- Existing quota guards are rolling request-count guards, not atomic reservations.
  Concurrent turns may race. No token-per-minute/day enforcement exists; tokens
  are recorded for completed runs, but failed-run token totals are unavailable.
  Groq still enforces its own TPM/TPD. A 429 fails over once or returns a wait.
- Existing card generation uses its current quota path; independent Groq caps
  added here apply to chat. Non-Groq providers retain the existing generic caps.
- Generation and conversation persistence have separate outcomes in diagnostics;
  there is no new persistence-status column or migration. The successful model-run
  row retains generation status even if turn storage later fails.
- No automatic retry, circuit breaker or cooldown cache is added. Repeated manual
  attempts remain subject to the existing persisted request guards.
- A lost HTTP response _after_ a completed turn commits remains ambiguous. There
  is no durable client request ID/deduplication across network replays or tabs.
  Provider-failure retries do not duplicate turns; exactly-once transport retry
  would require a separate idempotency design. Failed drafts persist in the
  current input, not across page reloads.
- Default small daily budgets may allow just one answering step at their tail;
  this existing behavior does not bypass validation or invent missing evidence.
- Deterministic reach ranking is feasible using `postsRanked` plus a fixed
  formatter and the same validator. A future task should offer an explicit
  structured ranking action (metric/date/filter arguments), with provider-free
  evidence rendering. Inferring arbitrary natural-language intent would expand
  scope and risk the existing views/reach semantics, so it is not added here.
- Branch Git deployments are disabled in `vercel.json`; no preview/production
  deployment, merge, live provider call or production DB test was requested/run.

## Validation

The original PR checks passed 203 unit/database tests and a webpack build.
The integration update adds checks for correlation/timing across failover,
successful provider usage before failed conversation persistence, and safe
behavior when writing the usage ledger itself fails. Updated results are recorded
in the PR description. Tests use disposable local databases and mocked provider
responses; production data and provider keys are not used.

The default Turbopack build was attempted again but its CSS worker failed to
bind a local port with `Operation not permitted`. Project build configuration is
unchanged; a supported webpack production build is used for local verification.

Integration validation results (2026-10-11):

- 222 unit/database tests passed across 19 files on a fresh disposable local
  PostgreSQL 17 instance, with `--testTimeout=30000`.
- 9 production-browser tests passed using system Chromium and a separate fresh
  synthetic fixture database. Includes all 7 existing deletion/navigation/privacy
  checks and 2 new chat HTTP/network retry checks. Provider responses were mocked.
- Typecheck, lint, formatting and `git diff --check` passed.
- Webpack production build passed with test-only browser instrumentation enabled.
  Default `npm run build` remains blocked by the Turbopack socket restriction.
- No migrations were added. No persisted environment settings, production data,
  provider credentials, deployments or merge state were changed.
