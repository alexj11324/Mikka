# Collapsed error codes (2026-11-05)

Alex, 2026-11-05: 「很多时候都会遇到这种问题，不同的原因都混到了同一个错误码上…很多其他地方都有问题」.
A production run ended with `report.summary` set to the raw string
`subscription_local_runtime_unavailable`: the daemon had collapsed several
different failures into that one code, thrown the real cause away, and the
thread showed the code itself because `messages/*.json` had no words for it.

This audit covers `lib/`, `app/`, `packages/daemon/src`,
`packages/protocol/src`, `packages/subscription-worker` (Go) and `workflows/`.
It looked for four patterns:

- **(a) dropped cause**: a `catch` that throws or returns a fixed code and
  keeps nothing of the caught error (no `cause`, no detail, no structured log
  of its name or code);
- **(b) one code, many preconditions** in one function or module, with nothing
  to tell them apart;
- **(c) user-reachable code without copy**: a code that reaches a run's
  `error` / `report.summary`, a chat failure mark, an API body or a toast, but
  has no entry in `messages/zh-CN.json` / `messages/en.json`;
- **(d) generic buckets** (`unknown`, `failed`, `*_unavailable`,
  `internal_error`) used as catch-alls.

The fix and the rule that follows from it are in
[decision 2026-11-05-0330](../design/decisions/2026-11-05-0330-error-causes.md).

## Production evidence

Read-only SQL on Neon (`autumn-fire-21908520`, `orvilo_mvp`), counts only, no
personal data:

| Source | Value (first 80 characters) | Rows |
|---|---|---|
| `agent_runs.error` | `subscription_hosted_runtime_unavailable` | 10 |
| `agent_runs.error` | The machine went offline and no other machine can continue the run. | 6 |
| `agent_runs.error` | Repository URL required; dispatch a new thread. | 4 |
| `agent_runs.error` | Model provider failed (balance: payment_required; HTTP 402) | 3 |
| `agent_runs.error` | `Claude Code: API Error: 402 Insufficient Balance (request_id: …)` | 4 |
| `agent_runs.error` | `subscription_local_runtime_unavailable` | 2 |
| `agent_runs.error` | Codex / Claude subscription execution failed (…) | 3 |
| `agent_runs.error` | Run policy distribution unavailable | 1 |
| `coordinator_sessions.lastError` | `Step "step//@ai-sdk/workflow@2.0.80//doStreamStep" failed after 0 retries: verification_required` | 20 |
| `coordinator_sessions.lastError` | same wrapper: `backend_unavailable` | 2 |
| `coordinator_sessions.lastError` | same wrapper: `Insufficient Balance (request_id: …)` | 2 |
| `byos_connections.lastErrorCode` | `publication_failed` | 1 |

The two runner codes are the largest single bucket of failed runs (12 of
about 40), and every one of them reached the person as a raw code. For none of
the 12 can the row tell which check failed.

## Top findings, by user impact

Impact counts how often it happens in production, whether a person sees it,
and whether anyone can work out the cause afterwards.

| # | Where | Pattern | Impact | Status |
|---|---|---|---|---|
| 1 | `packages/daemon/src/subscription-hosted-runner.ts:55` (`unavailable`), 21 throw sites from line 84 to 796 | b, c, d | 10 failed runs in production showed `subscription_hosted_runtime_unavailable` as the thread's summary and failure line. About 20 different checks (platform, CLI missing, assignment, resume, context revision, ledger, computer grant, env guard, credential placeholder, session id, adapter start, cleanup) threw the same code. Its causes were kept only on the last two. | **Fixed**: 15 details, cause kept, one structured log line, copy |
| 2 | `packages/daemon/src/subscription-local-runner.ts:19` and the `catch {}` at line 92 | a, b, c, d | 2 failed runs in production. 7 checks plus every `adapter.start()` failure (lease refused, model mismatch, the adapters' env guard in `adapters/codex.ts:333-345`, `SUBSCRIPTION_AUTH_ERROR` …) were rethrown as one code, with the cause dropped and nothing logged. | **Fixed**: 8 details, cause kept, log line, copy |
| 3 | `packages/daemon/src/runs/supervisor.ts:1484` | b | A device with no subscription runner configured throws the hosted runner's code, so "this machine cannot run subscriptions" looked like a cloud failure. | **Fixed**: `runner_missing` |
| 4 | `packages/daemon/src/adapters/claude.ts:109` `SUBSCRIPTION_ERROR` (13 sites; catches at 491, 576, 822, 857) | a, b, d | "Claude subscription authentication unavailable" for token shape, account mismatch, verify refusal, session record failure and provider refusal. The catches dropped the error, so the runners above could not tell a run that closed from a verify that refused. | **Fixed (cause)**: the four catches pass `{ cause }`; runners now read a wrapped refusal's detail. Sub-codes inside the adapter are not added. |
| 5 | `packages/daemon/src/adapters/codex.ts:99` `SUBSCRIPTION_AUTH_ERROR` (about 10 sites; catches at 564, 747, 819, 878) | a, b, d | Same as 4 for Codex, including the env guard at 333-345. | **Fixed (cause)**; the env guard is now also checked by the local runner as `env_not_clean`. |
| 6 | `lib/coordinator/group-runtime.ts:62-63` | b | Two internal faults (no hosted billing scope; a bot turn with no owner) threw `verification_required`, which the chat renders as the "verify your card" notice. The 20 production rows with `verification_required` cannot be attributed to this or to a real refusal from `lib/abuse/store.ts:143` / `:188`. | **Partly fixed**: same code (the chat's handling stays), with `billing_scope_missing` / `billing_owner_missing` details in the stored error. Not a `PaidResourceError`, so the points fallback does not take it for an empty balance. |
| 7 | `lib/subscription-access-snapshot.ts:17` and `:43` | a, b, d | The Infisical read for a shared subscription collapsed 7 steps (bad request, workload identity, fetch, HTTP status, body size, JSON, secret shape) into `subscription_access_unavailable` with no log. It reaches the device as a refused lease (finding 2). | **Fixed**: details plus a log line with no body or secret; a JSON parse error is deliberately not kept as the cause, because it quotes the body. |
| 8 | `workflows/` coordinator turn → `coordinator_sessions.lastError` | c | 24 rows hold the AI SDK wrapper `Step "step//@ai-sdk/workflow@2.0.80//doStreamStep" failed after 0 retries: …`, two of them with raw provider text. `lib/chat-failure.ts` still finds the known codes at the end, but the provider text lands on the generic 「失败」 line. | Not fixed (the chat parser already copes; raw provider text needs its own classifier) |
| 9 | `lib/subscription-service.ts:263-278` `subscriptionGenerationError` | d | Any error that is not a known refusal becomes `subscription_generation_failed`, and 5 worker codes become `backend_unavailable` (2 production rows), both shown as 「订阅暂时不可用」. The logs do keep the stage and class (`logGenerationFailure`). | Not fixed (diagnosable from logs; the copy is honest) |
| 10 | `packages/subscription-worker/oauth.go:81,86,120…`, `store.go:124,128` | a, b, d | `Repo.Fail(…, "publication_failed")` for 9 different failures (secret store, database insert, integrity, grant or access create). The Go error is returned to the caller but the stored code cannot tell them apart. 1 production row. | Not fixed (worker change; the stored code is not shown to people) |

Also found, lower impact:

- `lib/coordinator/summary-model.ts:19`: chat compaction failure became
  `subscription_generation_failed` without its cause. **Fixed** (`{ cause }`).
- `Codex subscription execution failed (…)` / `Claude subscription execution
  failed` (3 production rows) are English sentences shown raw in a Chinese
  interface. Not fixed; they need codes first.
- `lib/secrets/runtime.ts:24-82` (6 catches), `lib/github/user-access.ts:37-69`
  (5), `lib/model-api-keys.ts` (5), `lib/group-messages.ts` (4),
  `packages/daemon/src/api-key-broker.ts:121`,
  `packages/daemon/src/subscription-native-broker.ts:122`,
  `packages/daemon/src/run-mailbox.ts:74,98`: (a) drops that map to fixed API
  codes. Most of them already have copy through `Errors.*`. Not fixed; they are
  on the guard's allowlist.
- `lib/abuse/store.ts:143` and `:188`: two different conditions (no card and no
  trial left before a call; trial overdrawn while reserving) both give
  `verification_required`. They mean the same thing to the person, so they
  stay as they are.

## Pattern (a) across the codebase

When the guard landed, `scripts/error-cause-policy.mjs` found **128 throws in
79 files** that drop a caught error. They are the guard's
`droppedCauseAllowlist`. It can only shrink: a new drop fails CI, and fixing one
requires lowering that file's count. Most of them are API refusal codes that
already have copy (`ActionFailureError('runInvalid')`,
`WorkspaceError('secretsUnavailable')`, `FactoryError(…)`,
`CredentialError()`). The problem there is diagnosis, not what the person sees.

## Pattern (c): user-reachable codes

The run surfaces (the thread panel's failure line, the thread list's summary)
showed `agent_runs.error` / `report.summary` as they were. Codes that reach
them now have copy under `RunErrors.<code>.<detail>`. Subscription refusal codes
reuse `Coordinator.subscriptionRefusal.*`, the words the chat already uses.
Free text from an agent or provider is shown as before. The registry of
user-reachable codes is `packages/protocol/src/user-error-codes.ts`, and the
guard fails when a registered code or detail has no copy in both catalogues.
