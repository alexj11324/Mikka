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
isolated machine after infrastructure installs the gateway and key. All test
machines and snapshots were deleted. Synthetic test passwords never appear in
reported output. Runtime secrets are obtained from Infisical in process memory.

## Remaining acceptance

- Fixed application Preview and actual authenticated session/API tests.
- Dedicated thread worker registration/claim/end and snapshot refresh on real repo changes.
- Pausing a thread at a safe checkpoint without losing its run lease.
- Actual #180 broker deployment -> this gateway integration, including thread browser binding.
- Complete web-task actions (current durable worker supports navigation and observation).
- Browser-login cookie synchronization restricted to one owner.
- Frontend pill/card/settings acceptance remains outside this backend PR.
