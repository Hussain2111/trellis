# Resilient chat with Groq

Based on `main` at `deaaf38122e0b1b36a7cf9318e2b9347aec0c612`. PR #4
(`sd-01-performance-thread-deletion`) was open and unmerged when inspected on
2026-10-11. This branch does not include or alter its deletion/performance work.
Rebase and review overlapping chat-handler edits if #4 lands first.

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
failed attempts record the actual call-start count. The question and validated
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

- Frozen `npm ci --ignore-scripts`; dependency/lockfile versions retained.
- Full suite: 203 tests passed across 17 files, using a new disposable local
  PostgreSQL 17 container and `--testTimeout=30000`. Includes real transaction
  rollback and provider-scoped ledger checks. No production database was used.
- Focused SDK/route/provider/env tests passed, including primary success,
  overload/quota/network failover, exhausted guards, both providers failing,
  invalid credentials/models, tool failure, validated/unsupported Groq numbers,
  matching conversation context, single-provider use and failed-turn retry.
- Type checking, lint and repository formatting checks passed.
- `next build --webpack` production build passed. Default `npm run build`
  (Turbopack) was attempted but its CSS worker failed to bind a local port:
  `Operation not permitted`. The same failure persisted with elevated execution;
  no default-build success is claimed and project build configuration is unchanged.
- No browser UI automation, live Groq/Gemini inference, or authenticated Vercel
  deployment validation was performed. Adapter requests were mocked HTTP.
