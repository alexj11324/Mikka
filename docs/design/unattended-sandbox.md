# Unattended sandbox execution

Decision: Alex, 2026-10-29. Implements the unattended sandbox scope tracked in #404.

Status (2026-11-06): the runtime contract is now
[one task, one machine](decisions/2026-11-06-1800-machine-is-the-execution-boundary.md)
(#1505). The older Docker/sandbox, isolated HOME, provider-custody proxy and
per-call permission-gate requirements are superseded. The browser service's
own saved-login and human-viewer policy is a separate concern below.

## Execution defaults

One task owns one E2B VM. Claude Code and Codex run as its ordinary user with
normal HOME, environment, credential files and the actual Git repository.
There is no Docker container, read-only root, shadow `.git`, isolated GitHub
configuration or HTTP/CONNECT/provider relay around the CLI. Local worktrees
preserve the person's repository and unrelated work without adding another
remote authorization check before each call.

Prepare the run's selected native CLI subscription login or model key and its
authorized GitHub credential up front, or once when first needed. Other
user/workspace/repository third-party Secrets follow the
[credential-exposure decision](decisions/2026-11-08-0240-credential-exposure-boundary.md).
The source implements that distinction. `taskSecretInjection()` returns ordinary
env and explicitly approved direct Secrets in `env`, separates protected HTTP
Secrets for sealed run-scoped grants, and reports unsupported protected values
as unavailable. `effectiveSecretDelivery()` defaults missing or invalid metadata
to protected. Claim verifies worker capability and the secret snapshot before
returning grants. `lib/secrets/egress-http.ts` applies the approved HTTP scope;
`task-renewal.ts` renews grants through the existing heartbeat. This source check
does not establish deployed protected-secret acceptance.
Official CLIs connect directly to their providers. Agent tools use Claude Code `bypassPermissions` or Codex approvals
`never`; a read-only task is an instruction to the Agent. The machine receives
its resolved authority at admission. Revocation persists and pushes a stop,
or stops/reclaims the VM, rather than checking authority again before each
provider or tool operation. Natural token renewal happens in the background.

Agents reach the open internet by default
([1230](decisions/2026-11-01-1230-network-open-by-default.md)). The reusable
image contains no account credentials. Private task state stays with that
owner's VM and is never reused for another task.

## Browser tasks

These rules describe operations of the browser service itself; they do not
add a permission-preflight request to the task runtime.

The planner receives a current screenshot as an actual image input and chooses a
structured mouse, keyboard, scroll or drag operation. DOM evidence may assist the
model but button keywords do not grant business authority. Decisions supplies
semantic evidence; the existing host policy determines allow or deny.

Actions bind the owner, task, document, observation, policy revision and exact
mutation. A durable gateway receipt makes retries return the original result rather
than repeating a click. A stale observation requires a fresh observation. An unknown
external outcome must not be reported as success or blindly retried.

A saved login in the person's vault covers guarded fill and submission without
per-action approval cards. Account ambiguity, revoked grants,
MFA and an unknown result remain explicit stops. The broker retains secret masking
and origin, document and account checks.

## Availability and isolation

Cloud machines are keyed by workspace and account owner, not workspace alone.
Provisioning reserves durable identity before provider calls and releases database
connections while external creation is pending. Waiting for a person does not spend
the task's active-operation budget. Transient failures use bounded recovery; a
permanently failed queued start becomes terminal and cannot block later work.

The computer policy control exposes allow and deny
(`components/settings/computer-policy-settings.tsx`), round-trips its current
value, and remains disabled for non-administrators.

## Rollout and verification

Apply the repository's normal reviewed migration process for
`20261029080000_unattended_browser_runtime.sql` and
`20261029080001_owner_cloud_machines.sql`. A successful build or merge is not a
production migration. Existing explicit policy rows are not rewritten to allow.

The mandatory cloud-backend database gate includes the unattended regressions.
`pnpm test:unattended` checks visual input, policy and network contracts. The
unattended-sandbox workflow additionally executes the real Chromium gateway
(`scripts/e2b/subagent-guard.test.py`, `scripts/e2b/subagent-visual-browser.test.py`). Official CLI synthetic acceptance, the
full database inventory and affected API/CLI acceptance remain required.
The Python Chromium gateway tests exercise the browser service's own protocol;
application acceptance follows [acceptance.md](../acceptance.md), including
production-build screenshots for UI changes.
Model/provider fixtures establish protocol behavior, not live third-party account
acceptance. Preserve exact revision and environment provenance with test evidence.

No proactive recommendations or research, habit/location triggers, full onboarding,
knowledge-base expansion or local-browser-session import are included.
