# #342 backend verification

Implementation follows #342's 2026-10-27 evening comment and #343. No frontend
changes. This is a draft until the runtime, worker, broker integration and fixed
Preview have completed acceptance. Keep #342 open.

Preflight records:
- https://github.com/alexj11324/Mikka/issues/342#issuecomment-6454619709
- https://github.com/alexj11324/Mikka/issues/342#issuecomment-6454696548

A 2GB template ran eight independent Chromium processes with static pages and
real screenshots. Six left 777952KiB available; eight left 417468KiB. Six is a
conservative initial cap, not a general website-load guarantee. The gateway
also rejects a new process with less than 384MiB available. Extra work queues.

Full-memory snapshots cold-started in 0.767/1.261s but duplicate active daemon
connections and are unsuitable for threads. Filesystem-only snapshots are
supported: capture 0.498s; cold-ready 12.575s. Cache keys include owner/workspace,
source commit and lockfile digest, with a 24-hour refresh. Clones clear old
bootstrap/device configuration and viewer capabilities before starting their
own independently authorized device worker. Snapshots never cross owners.

Cross-machine signed CDP smoke returned 200 with a valid token and 401 without
it or with a malformed token. VNC's actual WebSocket returned RFB 003.008 with
valid view authority; missing/invalid tokens returned 401. A pause/resume kept
Xvfb, x11vnc and Chromium PIDs intact (3.495s).

Actual new gateway on an E2B disposable machine passed:
- Independent Chromium pipe transport, navigation and observation without input values.
- Viewer receives JPEG frames; it never receives a CDP transport or accepts input.
- Broker begin blocks model observations and viewers before filling.
- Filled input prevents end; history/hash changes cannot release the guard.
- Clearing inputs releases the guard; failure leaves it closed.
- Stop makes state unavailable; another owner's signed capability is rejected.

The test fixture is `scripts/e2b/subagent-live-acceptance.py`, executed inside the
isolated machine after infrastructure installs the gateway and key. Preflight test
machines and snapshots were deleted; controlled joint acceptance fixtures have
short expiry and are cleaned up after the HTTP acceptance. Synthetic test passwords never appear in
reported output. Runtime secrets are obtained from Infisical in process memory.

## Dedicated thread Preview acceptance

Fixed worker API Preview: `https://mikka-l6ajy50po-mikka-dev.vercel.app`,
source `9fb6b12fca8115eede222246b4f4f6b10fdd6ea0`. This is an isolated empty
Neon acceptance database with controlled users, sessions and repository fixtures;
no production rows or subscription credentials were copied.

Authenticated HTTP resume created two independent sandbox/device pairs in
39.248s and 38.145s, including filesystem clone, runtime installation, pinned
container image readiness and actual daemon registration/heartbeat. These are
full startup timings, distinct from the 12.575s bare snapshot cold-ready probe.
Both threads reused their owner's cached snapshot. Pause/resume returned 200
in 2.474/2.631s and 2.029/2.056s. Changing only the repository lockfile generated
a different snapshot and another independent device (37.574s).

A real issued device credential claimed its own run over HTTPS (200), with the
expected owner/workspace/route. Another thread's run or device token was refused
(401). Controlled connected subscription *metadata* enabled this infrastructure
claim; its secret reference deliberately does not identify a real credential.
The native subscription endpoint still returned application empty-body 401,
not Vercel protection HTML. Its existing hosted-device authorization and custody
configuration remain prerequisites for actual provider login or coding inference.
No new subscription credentials or permanent hosted-device exemptions were made.
The worker bootstrap privately carries the branch's Preview protection bypass;
actual registration and heartbeat use the same transport as daemon polling.

Ordinary browser navigate/click/type/key actions are implemented. Password and
OTP typing is broker-only; sensitive observations and display access remain
blocked until cleared. The model is instructed to request confirmation before
irreversible actions; its `irreversible` flag and the gateway's text/form
heuristics route detected actions through the existing pending_actions ledger.
These heuristics cannot determine arbitrary page-script effects and are not a
general guarantee that every irreversible operation is intercepted. Normal
navigation does not request per-action approval.
The credential broker's guarded CDP transport is a separate boundary: it only
attaches to the bound target, accepts the broker's fixed login/session scripts,
and rejects unknown methods, scripts, parameters and sessions. Cookie access is
restricted to the guarded origin and compatible parent-domain cookies. Unknown
cookie attributes or changed broker templates fail closed and require a
coordinated gateway update; they are not evidence of an ordinary browsing
approval sandbox. Local Chromium/WebSocket regression uses synthetic values.
Joint acceptance must keep #180's actual login provider and #342's actual browser
resolver; standalone seams intentionally fail closed without the other PR.

The linked issue and PR hold final fixed-SHA deployment, worker self-claim,
end/cleanup and joint broker HTTP results. Active native runs retain their
90-second lease; only idle unclaimed threads pause. Safely pausing an active
native run at a checkpoint, real provider consent/inference and frontend
pill/card/settings acceptance remain outside the demonstrated acceptance.
