# First hosted subscription run

This checklist is for the first real Claude run through Mikka. Passing the local
fixture tests below is not provider acceptance. E2B, multiple desktops and
cross-run continuation are separate work; the first run uses the existing Linux
Docker hosted adapter, without paid sandbox provisioning.

## Product path

1. Deploy the reviewed BYOS candidate with its built worker binaries and matching
   database migrations. The release owner coordinates this with other candidates.
2. Complete the existing enrollment transfer and binding using the real Mikka
   session and workspace authorization. Keep the source grant. The Mikka owner
   and Claude account can have different email addresses.
3. Register this Linux daemon through the normal device login flow. This creates
   persistent device access and must have the corresponding authorization. Add
   that exact device ID to `MIKKA_BYOS_HOSTED_DEVICE_IDS`; do not manufacture a
   device token or insert a session in SQL.
4. Create the owned Claude bot and subscription binding, then create/start the
   user task through Mikka's normal actions. `startRun` queues the run; the daemon
   claims it, the claim transaction binds the subscription run, and the hosted
   adapter proxies requests through the device-authenticated broker route.
5. Record the run ID, exact deployed SHA, lease/claim, provider response outcome,
   completion and returned result. Record only public task UI, never credentials,
   OAuth pages or valid links. Do not substitute a direct CLI/provider call.

## Bounded acceptance policy

The operator can supply a non-secret JSON file to the daemon using
`--hosted-subscriptions --subscription-request-budget <file>`. It has these exact
fields (replace placeholders with the real, authorized IDs):

```json
{
  "id": "<new UUID>",
  "ownerId": "<Mikka user ID>",
  "workspaceId": "<workspace UUID>",
  "consumerId": "<bot UUID>",
  "deviceId": "<registered device UUID>",
  "route": "claude_code_cli",
  "modelId": "<exact selected model>",
  "expiresAt": "<UTC timestamp within one hour>",
  "maxRequests": 2,
  "maxOutputTokens": 256
}
```

The broker reserves a request durably before forwarding it and caps the provider
output limit. Failure or an uncertain result consumes the reservation. Reuse the
same policy ID and daemon state directory across retries/restarts; do not create
a new policy to replenish an exhausted allowance. This is an operator-controlled
single-host acceptance budget, not a distributed billing or entitlement system.
A budget supplied without hosted mode is rejected. Ordinary product runs without
this optional policy retain their existing behavior.

The reservation directory is outside the CLI container. The CLI still receives
only a local proxy endpoint and placeholder authentication; vault and provider
credentials stay on the trusted server. A request rejected before upstream
transport does not count as a provider request, but an attempted upstream request
is never refunded automatically. Stop after two requests even if the task needs
more tool turns. No paid API fallback is allowed.

## Source validation

- Request-budget tests cover scope, expiry, immutable policy, restart persistence,
  malformed limits, output caps, socket transport and startup-mode enforcement.
- The hosted-runner test launches a fake CLI in the real Docker isolation and
  exercises its loopback proxy and mounted Unix socket: two capped requests reach
  the synthetic upstream and the third is refused. This is not real Claude auth.
- Type checking and lint must pass on the exact candidate.

## Remaining route boundaries

Authenticated Codex connection already has a device-code route. The separate
pending-unbound enrollment/transfer implementation is Claude-only. Hosted
cross-run continuation remains explicitly unsupported for both providers;
removing its rejection without validating ownership, session history and fresh
lease credentials would be unsafe. A fresh Claude task does not depend on this.

At the time this checklist was added, no real provider request had been made by
this candidate. Production deployment/binding and a real authorized device
session were still required. Neither synthetic upstream results nor local Docker
success prove that the existing subscription is usable through Mikka.

Local checkpoint on 2026-10-25 (base `384374a`, acceptance-budget patch):
focused hosted runner plus budget suite passed 7/7 before the final startup-mode
regression was added; the final budget suite passed 5/5. Typecheck and lint passed.
The expanded daemon suite was **not green**: 191 passed, 9 skipped, 3 failed.
The directory-permission precondition and setup-recipe timeout also reproduced
on the unmodified base (37 passed, 2 failed). The permission test assumes umask
0022, whereas this environment defaults to 0077; running it with its expected
umask plus the budget suite passed 16/16. The expanded run also timed out the
existing Codex Docker test at 45 seconds; this is retained as an unresolved full
suite result, not hidden by increasing its timeout. Independent review confirmed
the startup-mode enforcement fix and found no further confirmed budget defect.
