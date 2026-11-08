# Task review terminal — #1723

This implementation connects the cloud task terminal shipped by public PR #1754 and hosted UI PR #39. The browser talks to the task review API; it never selects a sandbox, port, repository, or operating-system path.

## HTTP contract

| Request | Result |
| --- | --- |
| `GET /api/tasks/:id/review/terminal`, accepting `text/event-stream` | SSE `event: output` with `{ "text": string }`, then `event: ended` with `{ "exitCode": number \| null }` after confirmed process cleanup. The first output frame is an empty string so the shipped hook becomes live immediately. |
| `POST /api/tasks/:id/review/terminal/input` with `{ "data": string }` | `204`. Optional UUID `requestId` provides at-most-once input when API clients retry; the shipped hook never automatically retries input. `X-Terminal-Request-Id` reports the chosen ID. |
| `POST /api/tasks/:id/review/terminal/resize` with `{ "cols": number, "rows": number }` | `204`; the actual PTY receives `TIOCSWINSZ`. |
| `DELETE /api/tasks/:id/review/terminal` | `204` only after durable revocation and the matching gateway's cleanup acknowledgement. A pending cleanup returns `503` and remains scheduled for reconciliation. |

Missing or unsupported terminal integration returns `404`; an accessible task owned by another member returns `403`; a reclaimed or changed execution binding returns `409`. An active Agent returns `423 terminal_already_controlled`, because it has not yielded physical checkout ownership. Other malformed, oversized and rate-limited input returns `400`, `413` and `429`. Every response is private and uncached. Unknown upstream diagnostics are reduced to registered error codes.

The cloud terminal is available after the current Agent has actually exited and the daemon has finished repository writes. A terminal status in the database alone is insufficient. An ordinary completed/failed run can retain its sandbox for review; its original VM may be resumed under a fresh review lease. Stopped/cancelled runs are revoked and return `409`. Opening a new review on a quota-parked run also remains `409` in this batch. The terminal does not pause an active native process, dispatch another Agent, mint a replacement device execution token, or create a new VM.

Local-machine remote terminals remain unsupported in this batch and return `404`. That part of the original issue remains open; a passing cloud acceptance must not be reported as completion of the local-machine target.

## Authority and execution handoff

`review-authority.ts` supplies the current human owner, membership, task visibility, latest run, repository binding, claim provenance, physical worktree, sandbox, machine epoch and operation. The API requires the same frozen workspace, admitted workspace, machine workspace and device-token workspace. Input rechecks current task authority and reads only an existing lease; it cannot create a PTY. No database query runs per stdout chunk or native Agent command.

The opening sequence is:

1. Resolve current task authority; reject an unsupported device or an Agent without verified native exit.
2. Under the shared authority transaction, create or reuse the original absolute review lease.
3. If parked, resume only the same sandbox after a machine/lease compare-and-set; check authority again afterwards.
4. Prepare the root gateway and authenticate its version/boot nonce using a fresh HMAC challenge.
5. Recheck authority and the exact lease under transaction locks; sign the one-use request against the already captured gateway boot.
6. After commit, send that exact signed request. Do not refresh the boot nonce or sign again after the transaction.

The daemon acquires a kernel `flock` before repository preparation, native prewarming, or execution. It retains the lock through verification, publishing and cleanup. Only confirmed native exit produces an idle receipt. The terminal takes the same fixed inode for the full PTY lifetime; a competing Agent waits. A missing control helper, lost lock, unsupported version or unconfirmed exit fails closed. Runtime refresh also takes this lock before stopping or replacing an idle worker.

`/run/mikka-review-control` is root owned and not writable by the execution user, so that user cannot unlink or replace the lock inode. The version marker is root owned and read only. The daemon's receipt itself is writable by its execution user; it is **not a root-authenticated native-exit proof**. Server-side claim-bound native-exit evidence is required independently.

The guarantees cover normal operation, contention, crash, disconnect and lost-control paths. They do not establish hostile-process isolation between arbitrary processes sharing the same Unix UID on one VM. Such a process can attempt to change that user's receipt or signal its control helper. The VM is the execution authority boundary; this change does not claim absolute same-UID secret isolation or introduce a new root process broker.

## Revocation, retention and data handling

The persistent review lease is tied to the task/run/owner/workspace/device/repository, machine epoch/operation, and the particular browser session or workspace PAT. Reconnect does not extend its absolute expiry. Shared lifecycle hooks revoke it on stop, task/owner/workspace changes, membership changes, credential revocation, machine change or a newer run. The gateway receives the exact revoked lease IDs and records tombstones before acknowledging cleanup, so a delayed open cannot resurrect a revoked shell. Explicit IDs affect only the corresponding terminal; another transport's lease is not closed accidentally.

A paused VM cannot be resumed by input or revocation. A provider-confirmed destroyed VM is a close acknowledgement. A provider-confirmed paused VM can be acknowledged without waking it only after every affected lease's absolute expiry. Every input, output, attach and queued-frame delivery checks wall time independently of event-loop timers, because pausing a VM freezes those timers. A missing health response from a running VM is not proof of cleanup.

The root gateway forks a real PTY and drops to the task's existing execution user. The shell uses the actual run worktree and a clean environment, retaining native HOME and PATH. It does not inherit application keys or gateway signing material. Root-only gateway files contain only the instance-derived key; the application's authentication secret is never copied to the sandbox.

Stdout and input are not written to a transcript, database, outbox, command log or request body log. The gateway keeps a bounded in-memory history. A natural shell exit drains final output, kills and reaps the complete descendant tree (including `setsid` descendants), and tombstones the lease before sending `ended`. Revocation and expiry discard queued output before acknowledging closure. A failed cleanup retains the execution lock.

| Bound | Value |
| --- | --- |
| Absolute review capability lifetime | At most 5 minutes, or remaining browser/PAT lifetime if shorter |
| Additional gateway hard lifetime ceiling | 15 minutes; it cannot extend the shorter review lease |
| No-input timeout | 120 seconds |
| Detached stream grace | 30 seconds |
| Concurrent PTYs / readers | One / one per sandbox; a reconnect replaces the previous reader |
| Scrollback | At most 256 KiB in memory |
| Single input | 16 KiB UTF-8 |
| Input rate | 64 KiB/s |
| Output rate / total | 128 KiB/s with a 256 KiB burst / 16 MiB |
| HTTP connections / queued output frames | 16 / 32 per reader |

## Verification and evidence

Run Node contract and authority-order tests with:

```sh
node --experimental-test-module-mocks --import ./tests/support/server-only.mjs --import tsx --test \
  lib/coding-workspace/terminal/wire.test.ts \
  lib/coding-workspace/terminal/http.test.ts \
  lib/coding-workspace/terminal/runtime.test.ts
pnpm --filter @mikka/daemon exec vitest run \
  src/runs/workspace-control.test.ts src/runs/supervisor.test.ts
```

Run actual TCP, non-root shell, process cleanup and PTY tests in an isolated Linux root environment with a mapped `nobody` user:

```sh
MIKKA_REQUIRE_REAL_PTY=1 python3 scripts/e2b/terminal-gateway.test.py
python3 packages/daemon/scripts/refresh-cloud-worker.test.py
```

`CI` or either required-real-PTY flag makes a missing Linux/root environment fail instead of silently skipping the PTY suite. A restricted runner mapping only UID/GID 0 cannot run the real-shell fixture; `fchown` errors or denied sockets are failed checks, not acceptance evidence.

The suites exercise actual `pwd`, Git status, a shell test command, terminal resize, Ctrl+C, exit code 7, reconnect, bounded real stdout, at-most-once input, execution contention, `setsid` cleanup, idle/detach deadlines and paused-wall-clock expiry. Node tests cover exact frontend events/statuses, cross-site refusal, payload bounds, committed grant ordering, scope/revoke races, pending close, authenticated gateway health, no implicit input resume and closed error diagnostics. Supervisor tests retain ownership until actual finishing cleanup and release acknowledgement.

Before production completion, attach immutable candidate SHA and Git-linked CI runs, real isolated PG authority/lifecycle results, official Claude Code `claude-haiku-5-5` and Codex `gpt-6-luna` runtime checks, deployment READY/served SHA, and sanitized production API requests/responses to #1723. A local test or mocked provider result is not production evidence. The queue and runtime release must finish before the backend deploy; frontend owners merge their own PRs separately.

## Merge risk and recovery

**Merge risk: high while integrated CI, Native runtime and production checks remain pending.**

**Alignment: good.** The shipped task API and SSE contract are retained. Active-Agent handoff is explicit and local-machine support is documented as incomplete.

**Impact: large.** The patch touches owner authorization, persistent capability leases, cloud worker execution ownership, process control and sandbox lifecycle. Closed tenant/owner checks, bounded credentials, native-exit proof, the execution fence and revoke tombstones are required mitigations, not optional follow-ups.

**Verification: incomplete until the recorded integrated evidence is attached.** Real PTY and isolated PG checks are necessary in addition to the Node contract tests. Existing workers without the new installed control fence remain unsupported until an owner-authorized idle runtime refresh or new approved runtime image provides it.

Gateway versions are exact immutable source hashes. An already running gateway with another hash returns `404`; this batch does not automatically replace its process. Worker refresh alone does not replace a gateway retained in the VM's memory. Reusing that VM across a later gateway code upgrade requires an explicitly authorized, safely idle gateway replacement, preserving the worktree. Until that replacement exists, a version mismatch must remain unavailable rather than bypassing the version check.

**Rollback cost: medium.** Revert through a PR and preserve additive lease rows until cleanup. Rollback of an idle worker removes the control version marker and refuses terminal admission to a legacy worker. The refresh execution lock prevents a runtime switch while an Agent or terminal owns the checkout. Do not delete user worktrees or revive an old device token to recover availability.

**Error detection: decent.** The API reports closed registered codes; pending remote cleanup remains in durable reconciliation, and unsupported worker/gateway versions return `404`. Log only request/status/closed diagnostic metadata. Review deployment health and actual terminal requests after rollout; never include typed commands, stdout or capabilities in telemetry or GitHub evidence.
