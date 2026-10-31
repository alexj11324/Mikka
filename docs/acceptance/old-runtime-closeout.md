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

## Current runtime attempts

The parent subsequently authorized Next dev against its frozen `375d6709`
checkout on port 3112. Actual signed application attestation passed against
the owned database; normal sign-up, session verification and workspace
initialization returned 200. The initial server bound `127.0.0.1` while its
attested origin used `localhost`; the absolute locale rewrite encountered a
second locale redirect. Binding the same `localhost` origin removed that
immediate redirect loop without changing tracked application source.

The root page's first compilation then exceeded the existing account client's
30-second request limit. The limit and landing requirement were retained;
the failed executors' four account pairs remain quarantined. A conservative
one-GiB Node heap also produced a retained development-compiler OOM. A later
Turbopack compilation approached the disk limit, so only this runner's owned
Next processes were stopped and its newly generated development caches were
removed. No existing database, ledger, Docker resource, production build,
credential inventory or failure log was removed.

These are failed infrastructure attempts, not passing HTTP or model evidence.
The release owner then supplied the exact main `375d6709` production build
from [CI run 41155092993](https://github.com/alexj11324/Mikka/actions/runs/41155092993),
artifact `13024479664`. ZIP SHA-256:
`4ac427d1436a031437d34015e6b434c8b2a451bfe664694e24c030983afc466a`.
Its embedded application SHA matched the full merged revision, and the
application's actual signed attestation passed after `next start --hostname
localhost --port 3112`. No source-equivalence assumption or old build was used.

### Passed device HTTP matrix

The actual production artifact passed the normal automatic owner/peer session
and two independent normal daemon CLI flows at `http://localhost:3112` from
2026-10-31 02:05:15 to 02:05:40 UTC:

- All 25 current `withDeviceRoute` HTTP methods returned 401 for the revoked
  credential, including the real register, heartbeat, claim, worker-related,
  report, checkpoint and capture routes.
- A command long-poll started before the owner revoked its credential returned
  401 in 701.6 ms. The actual daemon became unregistered in 1,547.2 ms.
- Peer, unauthenticated and wrong-Origin revoke requests were rejected;
  repeated owner revoke returned the same persisted receipt.
- The separately enrolled sibling daemon remained authorized. An actual
  restart of the revoked daemon remained signed out and the old credential
  still returned 401.
- The process and daemon logs passed the existing credential evidence audit.
  Retained fixture accounts were explicitly quarantined, not claimed reusable.

Evidence: `/tmp/mikka-runtime-closeout-375d/devices/result.json`,
`/tmp/mikka-runtime-closeout-ci375-service.log` and
`/tmp/mikka-runtime-closeout-375d/next-start-ci375.log`.

### Real native attempt: blocked by existing authentication

The subsequent run kept the same exact application version and production
artifact. It used separate fresh isolated targets for native preparation,
preserving the prior database and its quarantined identities. The default
signup rate guard correctly rejected the exhausted earlier hourly fixture
quota; no rate-limit counter, authentication guard or quarantine was reset.
Retained additional databases are `mikka_old_native_stop_e2e`,
`mikka_native_mcp_e2e` and `mikka_native_tls_e2e`, each initialized with all 154
migrations and Better Auth on the same explicit local PostgreSQL service.

Normal MCP public native-client registration, PKCE, the application-issued signed
consent query and token exchange passed. The actual test owner's CLI policy
was configured through its authenticated HTTP endpoint before the existing
`create_issue` and `dispatch_run` MCP tools were invoked. The initial fixture
incorrectly configured a web callback, omitted the signed consent query and
set a worker policy that could only narrow the Agent policy; those failures
were retained and the test client was corrected to the existing contracts.
No application authorization was weakened.

The daemon's production `protocol.file.allow=never` correctly refused an early
local Git URL rewrite. The final fixture instead served a real local HTTPS Git
repository and passed `git ls-remote` with file transport still forbidden.
Its temporary TLS private key stayed in process memory; Git verified the
fixture's public CA with `GIT_SSL_CAINFO`, without disabling verification.
No real hosted repository or provider business object was written.

The final actual Mikka run `701f0f7c-a4ce-400b-b5c1-ecbe3fde6a98` reached the
official existing Codex CLI and created a native app-server session. Its first
provider call failed with:

> Codex: Your access token could not be refreshed because you have since logged
> out or signed in to another account. Please sign in again.

`codex login status` had reported a ChatGPT login, but that status did not prove
usable inference. No model substitute was installed and no authentication
value was read into a report or changed. This failure does not establish a
live-model report, native cancellation SLA, scheduled read or cross-node
inference. All owned daemon/Git/proxy processes ended; application source and
dependencies remained frozen through this attempt, then the parent was given
an explicit release of that freeze.

Evidence: `/tmp/mikka-native-stop-375d-VXpl5r`,
`/tmp/mikka-native-stop-tls375-attempt3.log`,
`/tmp/mikka-native-tls375/environment.json` and its private application log.
An independently invoked official Codex read-only authentication probe also
exited 1 with the same refresh rejection and no inference result. It completed
before the parent's pause instruction; no further model attempts were made.
Its private output remains in `/tmp/mikka-direct-codex-probe`.

All four issues remain open for the remaining runtime acceptance in the table
above. In particular, #178's passed infrastructure matrix is not a claim that
its active real-model stopping requirement passed.

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
