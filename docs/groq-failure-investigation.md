# Groq fallback failure investigation

## Finding

Root cause is **not established**. This branch adds diagnostics and reproduction
coverage, not a speculative model, key, schema or retry-policy fix.

The supplied production evidence at commit `faad585b` shows Gemini completed a
SQL-tool step and then failed transiently after two SDK model-call starts. Groq
was selected and recorded one start, an `application` failure and a 3 ms duration.
A model-call-start callback precedes adapter preparation/transport. That record
does not prove a valid request reached Groq, or identify the exception.

Inspected AI SDK 7.0.77, OpenAI-compatible adapter 3.0.39, the provider factory,
chat handler, generation options, tools, conversation persistence and error
wrapper. The adapter serializes required/none tool choice directly. Lifecycle
callbacks swallow exceptions; the existing tool-error stop condition remains.
Fallback receives the same history/system/current question, starts a new tool
loop, checks its own ledger and does not reuse incomplete primary output.

The existing mocked adapter tests used one empty-schema synthetic tool. Expanded
tests use **all eight real Trellis tool definitions**, including enum metrics,
defaults and optional filters. With the configured model ID, temperature 0.4 and
required tool choice, the installed SDK serialized a mocked HTTP request, executed
a synthetic reach-ranking tool result and passed it into the final answering
request. The numerical validator accepted backed figures and removed unsupported
ones. No local pre-HTTP schema/model/tool-choice rejection was reproduced.

This establishes local serialization compatibility, **not live Groq acceptance**,
account/model permission or production transport health. No API-key conclusion
or model change follows from the timing alone. No live inference was attempted.

## Diagnostic change

`[chat.failure]` contains an allowlisted metadata object: correlation UUID,
optional bounded `x-vercel-id`, configured provider/model, stage, classification,
allowlisted exception name/SDK error code, HTTP status when observed, a transport
attempt flag, fallback-selection flag and elapsed milliseconds. Error messages,
causes, response bodies, prompts, tool payloads, headers, URLs and SQL are absent.
The model-run table continues to store only the existing failure classification.

A request UUID is returned in `x-trellis-request-id` and used in chat logs even
when performance instrumentation is disabled. With instrumentation enabled, the
same UUID feeds existing timing scopes and Server-Timing behavior. An incoming
UUID must match the existing v4 validation; other values are replaced.

The provider adapters use an instrumented fetch function that only observes
invocation and response status. AsyncLocalStorage isolates concurrent attempts.
`httpRequestAttempted` refers to fetch entry for the **failing model call**;
it resets on each call start. It does not establish socket transmission or Groq
receipt: fetch itself can reject during header/network validation. Missing status
is unknown, not a guessed response. Preparation, transport, response and tool
stages are observations, not an inferred root-cause verdict.

No provider classification or retry policy changes, migrations, new dependency,
provider/model changes, production settings/data operations or deletion changes.
Existing usage-before-persistence ordering and atomic successful turns remain.
Git deployments are disabled for the investigation branch.

## Evidence still needed and reviewed verification procedure

After review, an operator may deploy the diagnostic change through the normal
approved workflow. This task does not deploy it. Avoid changing quota/key/model
settings before capturing the failure; that would obscure the cause.

Prefer capturing one naturally occurring failure. Record its HTTP response
`x-trellis-request-id`, the hosting request record and matching `[chat.failure]`
events for Google and Groq. Required evidence: Groq exceptionName/sdkErrorCode,
failureStage, httpRequestAttempted and HTTP status if present. Share only that
sanitized metadata and elapsed time; do not export raw provider payloads, secrets,
conversation text or database data. An unavailable `x-vercel-id` is omitted;
the returned UUID still links the response to application logs in the hosting
request's log stream.

- Preparation failure: use the recognized SDK code/class to reproduce the specific
  adapter or prompt conversion failure with synthetic inputs.
- Transport entry without status: investigate secure credential formatting,
  runtime fetch and outbound connectivity **only when supported by the exception
  evidence**; this does not establish invalid authentication.
- HTTP response: use the observed status/category to investigate documented
  model permissions or request compatibility, without exposing response bodies.
- Tool execution: investigate the local query/tool failure; do not fail over an
  application/database error.

Further live testing is not required to land diagnostic coverage, but the actual
failure cannot be called fixed without new production/runtime evidence. If that
metadata still leaves a provider incompatibility unresolved, obtain explicit
user authorization for **one** minimal live Groq request using securely supplied
credentials and synthetic tools/data. Do not make repeated Gemini/Groq calls.

The usage ledger continues its existing conservative SDK call-start accounting;
a recorded call is not a new claim about provider billing or network transmission.
The diagnostic does not retroactively rewrite usage records.

## Automated validation

- 225 unit/database tests passed across 20 files on disposable local PostgreSQL
  17, using `--testTimeout=30000`. An initial database-startup/migration readiness
  failure was corrected before this successful run.
- Expanded adapter tests passed with all eight real tool definitions and mocked
  HTTP/SQL-query results; privacy tests cover pre-HTTP SDK failures, transport
  observation isolation and correlation with performance disabled.
- Typecheck, lint, formatting and diff checks passed.
- Webpack production build passed. The known environment Turbopack local socket
  restriction remains; no default-Turbopack success or deployed validation is
  claimed. Browser tests were not rerun because chat rendering/deletion code is
  unchanged; the correlation change is exercised in route tests.
- No live provider inference, production DB tests, deployments or setting changes.
