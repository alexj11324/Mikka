# Older runtime acceptance closeout

This run starts from merged application `375d670937ca06c53e47f336870481d38520c1fe`.
Its new disposable PostgreSQL 17 target is
`127.0.0.1:55599/mikka_old_runtime_closeout_e2e`; all three application database
URLs select that same target. All 154 migrations and Better Auth initialization
passed (`/tmp/mikka-runtime-closeout-setup.log`). Earlier integration databases,
Docker containers and migration ledgers remain retained.

The passed component evidence remains in
[`old-backend-batch-20261030.md`](../integration/old-backend-batch-20261030.md).
Neither that evidence nor the merged PR alone closes these issues.

| Issue | Remaining runtime acceptance |
| --- | --- |
| #176 | Activate the existing minute Worker after the matching application/schema is available; demonstrate failed wake delivery recovering without a new message and one original-chat result with the real consumer |
| #178 | Normal enrollment and live daemon requests, owner/peer rejection, pending-request revocation, old-token rejection after restart, then an active real harness's stop timing |
| #179 | A real model selects the existing schedule tools through chat, persists once/repeat definitions, completes two repeated occurrences and an authorized `agent_read`, and reports to the original chat |
| #209 | Two independent daemon/harness nodes, partition of the old control path with the protected action endpoint still reachable, independent takeover, old-attempt refusal, checkpoint restoration and STOP timing |

## Device credential HTTP acceptance

`scripts/acceptance/device-closeout.mjs` attaches only to a matching, attested
loopback application via the existing automatic account allocation mechanism.
It does not start/build an application, mint an application cookie, replace a
server or model, or weaken the environment/lease checks. Set the usual three
identical isolated database URLs, `MIKKA_TEST_ENVIRONMENT_FILE`,
`MIKKA_TEST_DEPLOYMENT_SHA` and matching authentication origin as for the normal
account-pool runner. The corresponding application build must identify the
same code revision; the earlier local build identifies `3ae8a561`, so it cannot
be relabelled as this revision.

```sh
PATH=/tmp/mikka-runtime-tools/usr/bin:$PATH \
MIKKA_CLOSEOUT_EVIDENCE_DIR=/tmp/mikka-device-closeout-375d \
node --import tsx scripts/acceptance/device-closeout.mjs
```

The runner obtains a one-use enrollment through the owner's actual HTTP
session and launches two independent normal CLI processes with separate state
directories. It verifies peer/unauthenticated/origin rejection, idempotent
owner revocation, a command long-poll already in flight, every current
`withDeviceRoute` HTTP method, the sibling credential, and an actual daemon
restart with continued refusal of the original credential. Its private result
records the fixed revision, timing, resource IDs and limitations. Business
fixtures and audit rows are retained deliberately; the automatic account lease
is released as dirty/quarantined rather than claimed reusable.

This check does **not** execute a model or an active harness task. Two processes
on one Linux host are independent daemon instances, not two remote machines.
Those remaining acceptance steps must be recorded separately.

The initial real CLI startup/drain probe passed. Its sandbox preflight found
the host lacked `socat`; no production code or sandbox policy was changed.
The official Debian 13 `socat_1.8.0.3-1+deb13u1_amd64.deb` was downloaded over
HTTPS and extracted into `/tmp/mikka-runtime-tools`, without a system install.
Package SHA-256:
`c87c1e6eccc6d5828138dda794d28a7f283fe4e4010074fffbe4dc8354eef08d`.
With that temporary PATH prefix, the actual sandbox dependency check reported
no errors or warnings and its bubblewrap/network isolation probe passed.
The installed official CLI identifies as `codex-cli 0.163.0`; availability is
not evidence of a successfully authenticated inference.

## Existing minute Worker

The resource is already configured as `mikka-suggestions-cron` in
`cloudflare/suggestions-cron/wrangler.jsonc`, with `MIKKA_URL` pointing at
`https://app.aspectlylabs.com/mikka`. Its minute handler independently awaits
the wake, schedule and run-recovery endpoints. The earlier briefing,
suggestion-reconcile and user-facts schedules remain configured.

After the unified release owner verifies the matching application and all
pending migrations, deploy this existing resource using its existing identity
and existing `CRON_SECRET` synchronization:

```sh
node node_modules/wrangler/bin/wrangler.js deploy \
  --config cloudflare/suggestions-cron/wrangler.jsonc
```

Read back the active version/cron configuration and retain real scheduled
invocation logs for all three minute endpoints. Source configuration, a manual
HTTP call and a local timer do not prove the deployed minute trigger runs.
This child agent has not deployed or modified cloud configuration.

## Real-model identity boundary

The existing `isolated-ci` account adapter intentionally rejects real model
credentials and `MIKKA_NATIVE_COORDINATOR=1`; the application attestation route
uses the same validation. Adding those to its server and bypassing attestation
would invalidate this evidence. Real-model acceptance instead needs an already
supported authorized test-identity setup, as described in
[`acceptance.md`](../acceptance.md), with its own precise environment record.
The release owner is checking the existing model/Infisical/deployment path.
No real model, provider action, production rollout or issue closure is claimed
by the startup probe or by this acceptance runner's source.
