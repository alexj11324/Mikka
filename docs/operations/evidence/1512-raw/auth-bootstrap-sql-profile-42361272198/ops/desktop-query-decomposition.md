# Issue 1512: sequential HTTP / PostgreSQL decomposition

Prepared diagnostic; no database, server, browser or provider has been run while preparing it.

## Invocation

The reviewed workflow checks out product source `3ad0fe25438887fe04f6dc6bda140f35d0bf4a03`, installs its pinned dependencies without browser/Electron binaries, and extracts the verified Linux `.output` artifact. This source has tree `afe77de97310d38eb230d3ff0ee91f639ca5b8d1`, identical to candidate `0d33e1bd7b170abe7cb0b8c9d1fef42bc951c920`. The artifact is the separate successful Linux build, not the macOS build.

```sh
node ops/.github/issue1512-sql-profile.mjs \
  --source "$GITHUB_WORKSPACE/source" \
  --artifact-zip "$RUNNER_TEMP/desktop-api-build.zip" \
  --output "$GITHUB_WORKSPACE/evidence/desktop-query-decomposition.json"
```

The only required explicit environment value is the workflow-owned `E2E_DATABASE_URL`: PostgreSQL user `e2e`, address `127.0.0.1:5432`, database `mikka_e2e`. The driver requires the real authorized GitHub-hosted Linux job, Node `24.22.1`, the exact source tree/parents, and the immutable ZIP's byte count and SHA256. It never changes GitHub's source/run variables. It creates random local auth/secrets only in process memory, calls the existing isolated schema/bootstrap scripts, and starts one existing compiled Nitro API at `http://localhost:3000` with the original `db-metrics.cjs` preload.

The account lease helper provisions and signs in through ordinary email authentication. Its separate PG connections and fixture writes are not part of the API query counter. The original parity fixture contains a disabled device and completed task; no work is dispatched. No live service credentials, external authentication, model calls, VM, Electron, browser, or Live subscription is involved. The source's real one-shot `startBundledLoopback` receives the PKCE code. Playwright's **HTTP-only APIRequestContext** consumes the helper's private storage state; it does not install or launch a browser.

## Fixed request plan

| IDs | Actual requests | Interpretation |
| --- | --- | --- |
| `web_sign_in`, `web_get_session` | Original `owner.reauthenticate()`'s sign-in and get-session, measured separately | Ordinary Web email authentication |
| `web_bootstrap` | Browser RPC `desktop.bootstrap`, `args:[]` | Default workspace read |
| `web_session` | Browser RPC `desktop.session` | Additional action comparison |
| `native_sign_in`, `native_get_session` | The same original helper, after the Web HTTP context closes | Ordinary auth before native handoff |
| `pkce_begin` | Native unauthenticated POST begin | Real nonce/challenge registration |
| `system_browser_bootstrap` | Browser RPC `desktop.bootstrap`, `args:[]` | Current 0d33 confirmation-page read |
| `pkce_return` | Cookie-authenticated GET return, no automatic redirect | Real binding and one-time code |
| `pkce_exchange` | Native POST exchange after the exact owned loopback receives that code | Real same-browser-session bearer and signed cache |
| `native_bootstrap` | Bearer RPC `desktop.bootstrap`, `args:[]` | Default workspace read |
| `native_session` | Bearer RPC `desktop.session` | Additional action comparison |
| `native_task_runs_first`, `native_task_runs_second` | Two separately measured `task-runs.pollTaskRuns`, one request each | Per-read cost; not a simulated Live catch-up |

All three bootstrap calls must return the actual fixture workspace. The driver never supplies a workspace selector or workspace cookie and never sends `workspace.switchWorkspace`. It preserves normal signed session-cache responses. Successful identities must match the actual leased account; the exchanged native session must match the confirmation's browser session. Values remain private; only match booleans are reported.

## Complete safe report shape

The sole output is bounded to 256 KiB, mode `0600`. The workflow uploads only explicitly named safe JSON files. Every key below is constructed by the driver or the existing numeric counter projection; no response, SQL, raw log, credential, cookie, email or account identifier is spread into it.

- `version`, fixed `kind`, `productionAcceptance:false`, `startedAt`, `finishedAt`, `elapsedMs`, `status` (`passed`/`failed`).
- `source`: fixed `source`, `candidate`, `tree`, `parents`, `artifactId`, `artifactRunId`, `artifactAttempt`, `artifactBytes`, `artifactSha256`; booleans `verified`/`compiledVerified`; validated package `clientVersion` when available.
- `runner`: real GitHub `runId`, `attempt`, `operationRevision`; runtime `platform`, `arch`, `node`. Missing or invalid identity stops before setup.
- `measurement`: the fixed explanatory strings `source`, `scope`, `cache`, `workspace`, `interpretation`, `background`, `protocol`, `taskReads`, `comparisons`, plus fixed `exclusions`.
- `phases[]`: closed `name` and numeric `elapsedMs`.
- `counter` when available: exact validated `revision`, `platform`, `arch`, `runtime`, `pid`, fixed `process` description.
- `fixture` when created: `originalParityFixture`, `endedTask`, `disabledDevice`, `explicitWorkspaceSelector` booleans.
- `requests[]` (maximum 14): fixed `id`, `route`, registry `action` or null, fixed `purpose`; `status` (`running`, `http_complete`, `passed`, `failed`), numeric/null `httpStatus`; `before`, `after`, `delta`, and `sameApiPid` when collected. Optional `receipt` contains only `originalLeaseIdentityValidated`, `sameLeasedOwner`, `cacheWorkspaceMatchesFixture`, `exactOwnedLoopback`, `sameBrowserSession`, `signedCachePresent`, `carriedNormalSignedCache`, `fixtureTaskFound` booleans, and numeric `itemCount`. An HTTP response that fails a later semantic check is not relabelled `passed`.
- Counter snapshot: `version`, `runtime`, `pid`, `startedAt`, `endedAt`, `instrumentedClients`, `queryCalls`, `pgProtocolReceiveBytes`, `pgProtocolSendBytes`, `activeConnections`, `closedConnections`, `unknownReadings`. Each numeric value must be a nonnegative safe integer. Unknown readings, PID/runtime/start changes, or decreasing cumulative counters fail.
- Counter delta: ISO `startedAt`/`finishedAt`, numeric `durationMs`, `queryCalls`, `pgProtocolReceiveBytes`, `pgProtocolSendBytes`, `closedConnections`, `unknownReadings:0`.
- `gaps[]`: fixed `beforeRequest` plus a counter delta between requests and once before cleanup. These are retained, not subtracted from any request.
- `failure` when present: closed `phase`, closed `name`, driver-literal `code` or `DEPENDENCY_OR_RUNTIME_FAILED`. No caught error message or stack is emitted. Per-request/cleanup failures use the same projection without `phase`.
- `cleanup`: fixed keys `http_context`, `owned_loopback`, `owned_pkce`, `fixtures`, `lease`, `setup_process`, `api_process`, `private_account_files`, `private_runtime_files`, `owned_metrics_socket` when applicable. Each has `status` (`passed`/`failed`); successful fields are only context counts `created`/`disposed`, PKCE `removedRows`, lease `state` (`released`/`quarantined`), or API `exited:true`/`forcedKill:false`. A failed item contains the closed error projection.
- `summary`: numeric `completedRequests`/`comparisonRequests`; `sameApiPid`, `cleanupComplete`; `unmeasuredGaps` with the three numeric query/protocol-byte totals.

All subprocess stdout/stderr is ignored, not read or uploaded. Cleanup closes HTTP contexts and the owned loopback; removes only this nonce/challenge/callback/leased-owner PKCE row; runs the original fixture cleanup and account lease release; then waits for the owned API process to exit using the original bounded shutdown helper. Forced termination remains failed evidence. The workflow separately deletes its downloaded ZIP and disposes its own PostgreSQL service/runner.

## Interpretation and validation boundary

This measures sequential whole-process windows in a warm Linux API. An asynchronous API background query or late PG bytes can overlap a window or gap; nothing is guessed away. The 14 requests include two extra `desktop.session` comparisons and are **not** an ordinary login total. No subtraction of these numbers can prove the exact attribution of the earlier concurrent macOS Native +20 queries. It does establish the actual cost of the requested actions, with normal authorization/cache and a fixed default fixture scope.

Preparation validation is syntax/lint and static source-contract review only. The first real isolated job must validate startup, exact compiled attestation, all 14 responses and cleanup. This is not production acceptance, real OAuth-provider acceptance, a macOS startup result or a replacement for its full lifecycle gate.
