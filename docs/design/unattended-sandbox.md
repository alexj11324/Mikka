# Unattended sandbox execution

Decision: Alex, 2026-10-29. Implements the unattended sandbox scope tracked in #404.

## Execution defaults

An authenticated, owned cloud device receives public web egress by default.
An unbound or local worker receives bounded local network defaults. A model,
request payload or a device owned by another account cannot select cloud authority.
Existing explicit ask/deny choices, read-only runs and administrator ceilings remain
binding. Project dependency installation is allowed by default within the sandbox;
project shell execution does not require Git publication permission.

A destination ceiling limits reachability; it is not consent. An effective network
allow proceeds without a prompt. An explicit ask obtains one exact host/port grant
and reuses it within the same run. Concurrent connections share that decision.
Every connection still rechecks live authority; cancellation, revocation or a new
run cannot reuse the old grant. Publication and other external effects retain their
own host-controlled authorization.

Hosted tasks keep Docker network-none, a read-only root filesystem, a private task
home and provider credential custody outside the task. The owned HTTP/CONNECT relay
allows public web destinations, rejects private/metadata addresses and validates the
complete DNS answer before connecting to the selected address. It does not inject
platform credentials into arbitrary requests. Applications must honor the supplied
proxy configuration; this is not unrestricted host networking.

## Browser tasks

The planner receives a current screenshot as an actual image input and chooses a
structured mouse, keyboard, scroll or drag operation. DOM evidence may assist the
model but button keywords do not grant business authority. Decisions judges
whether the action serves the task; the host policy then allows it, or blocks it
under a workspace or per-effect deny. No action waits for a human approval
(2026-10-30, `decisions.md`).

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

The computer policy control exposes 允许（默认） and 禁止 (allow and deny),
round-trips its current value, and remains disabled for non-administrators.

## Rollout and verification

Apply the repository's normal reviewed migration process for
`20261029080000_unattended_browser_runtime.sql` and
`20261029080001_owner_cloud_machines.sql`. A successful build or merge is not a
production migration. Existing explicit policy rows are not rewritten to allow.

The mandatory cloud-backend database gate includes the unattended regressions.
`pnpm test:unattended` checks visual input, policy and network contracts. The
unattended-sandbox workflow additionally executes the real Chromium gateway and a
real network-none Docker public download. Official CLI synthetic acceptance, the
full database inventory and selected application browser gates remain required.
Model/provider fixtures establish protocol behavior, not live third-party account
acceptance. Preserve exact revision and environment provenance with test evidence.

No proactive recommendations or research, habit/location triggers, full onboarding,
knowledge-base expansion or local-browser-session import are included.
