# Unattended sandbox execution

Decision: Alex, 2026-10-29. Implements the unattended sandbox scope tracked in #404.

Status (2026-11-03): runs no longer use a sandbox, a Docker container or a
network relay, and nothing is asked per tool or destination
([1312](decisions/2026-11-01-1312-cloud-runs-without-docker.md),
[2335](decisions/2026-11-01-2335-e2b-official-templates.md)). The sections
below say what holds now.

## Execution defaults

An authenticated, owned cloud device receives public web egress by default.
An unbound or local worker receives bounded local network defaults. A model,
request payload or a device owned by another account cannot select cloud authority.
Existing explicit ask/deny choices, read-only runs and administrator ceilings remain
binding. Project dependency installation is allowed by default within the sandbox;
project shell execution does not require Git publication permission.

Agents reach the open internet by default
([1230](decisions/2026-11-01-1230-network-open-by-default.md)). A run asks for
no per-host grant: Claude Code runs in `bypassPermissions` and Codex with
approvals `never` (2335). The daemon's live gate
(`packages/daemon/src/agents/tool-approval.ts`) still stops a run whose lease,
owner or policy is no longer live. Publication and other external effects
retain their own host-controlled authorization.

Each hosted task runs on its own E2B machine, which is the isolation between
tasks; there is no Docker container, read-only root or HTTP/CONNECT relay.
Provider credentials stay outside the task: the CLI reaches the model only
through the run's broker.

## Browser tasks

The planner receives a current screenshot as an actual image input and chooses a
structured mouse, keyboard, scroll or drag operation. DOM evidence may assist the
model but button keywords do not grant business authority. Decisions supplies
semantic evidence; the existing host policy determines allow, ask or deny.

Actions bind the owner, task, document, observation, policy revision and exact
mutation. A durable gateway receipt makes retries return the original result rather
than repeating a click. A stale observation requires a fresh observation. An unknown
external outcome must not be reported as success or blindly retried.

A saved account's explicit same-owner/site unattended-login grant can cover guarded
fill and submission without two approval cards. Account ambiguity, revoked grants,
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
full database inventory and selected application browser gates remain required.
Model/provider fixtures establish protocol behavior, not live third-party account
acceptance. Preserve exact revision and environment provenance with test evidence.

No proactive recommendations or research, habit/location triggers, full onboarding,
knowledge-base expansion or local-browser-session import are included.
