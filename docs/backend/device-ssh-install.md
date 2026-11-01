# Device SSH backend (#491)

Scope: backend, Electron main/preload and daemon. React and visual acceptance
belong to #504. This change adds no frontend screen or feature flag.

## Desktop contract for #504

The existing trusted-origin preload exposes optional `window.mikka.ssh`:

- `hosts(): Promise<{ alias, user, hostName, port }[]>`: explicit host aliases from the desktop user's
  `~/.ssh/config`; wildcards and negated patterns are excluded. OpenSSH resolves
  each alias with `ssh -G`; `user` and `hostName` are strings and `port` is a number. Identity and other SSH options remain internal.
- `begin(target)`: accepts `alias` or `[user@]hostname[:port]`; returns the
  installation snapshot. Only one installation runs at a time.
- `accept(id)`: accepts exactly the pending snapshot's host fingerprint,
  records that key in the desktop user's `~/.ssh/known_hosts`, then continues.
  Without this call, an unknown host receives no installation command or token.
- `cancel(id)`: stops the active discovery or install child process and reports
  `status: failed`, `reason: cancelled`, `retryable: true`. Completed remote steps
  remain in place. A retry uses `begin` with a new id after cancellation settles.
- `state()`: restores the latest snapshot after a view reload.
- `onChange(listener)`: subscribes to snapshots; returns an unsubscribe function.

Snapshots contain `id`, `target`, `step` (`login`, `check`, `install`, `service`,
`connect`) and `status` (`fingerprint`, `running`, `online`, `failed`). A
fingerprint snapshot contains `fingerprint` (SHA256 only) and `keyType` (e.g. ED25519); a failed snapshot includes `reason`
and `retryable`. The online snapshot includes the registered `deviceId`. Retry calls `begin` again, obtaining a new registration grant.
The event stream carries no credential. Only trusted app main frames may invoke
IPC. Browser clients have no SSH bridge and keep the existing three commands.
The obsolete server-side `/api/devices/ssh` installer now responds 410.

Authentication is OpenSSH agent/key authentication, with password and
keyboard-interactive authentication disabled. Host checking is strict, including
on all commands after confirmation. Changed known keys are rejected.

## Registration

`POST /api/devices/enrollment` requires a same-origin, signed-in application
session. Electron uses its existing session partition to call it from main.
The returned grant expires in five minutes, is hashed at rest and is bound to
the session's user. It is passed over SSH stdin, never argv or shell source.

`mikka daemon login --server <app-url> --registration-token-stdin` exchanges it
at `POST <app-url>/v1/devices/enroll` for the normal `orv_` daemon credential.
The database consumes the grant and issues the credential in one transaction;
concurrent replays have exactly one winner. No browser code approval is used.
Existing device authentication and registration remain in effect.

## Installation and service commands

The desktop and web both use `daemonCommands().install`, currently
`npm install --global @aspectlylabs/mikka`. The host must already have Linux or
macOS and a compatible Node installation. The engine requirement is read from
the daemon source manifest and copied into the published manifest.

`mikka daemon service install --server <app-url> --device-type server` writes a
systemd user unit on Linux or a launchd agent on macOS. The Linux path attempts
`loginctl enable-linger` without prompting; policy may refuse linger while the
user service still runs. Both managers restart failed processes. SSH-installed
services set `MIKKA_DEVICE_TYPE=server`; registration stores this in
`devices.deviceType`. Existing registrations without a reported type default
to laptop. `listDevices` exposes the stored type and detected harnesses.

`sendDeviceCommand({ deviceId, kind })` in `app/actions/agents.ts`, or
`POST /api/devices/:deviceId/commands` with `{kind}`, queues `redetect`, `restart`
or `update`. Both enforce ownership and exclude managed cloud devices.
`GET` on that HTTP route returns the owner's recent command receipts, including
`createdAt`, `completedAt` and `error`. An offline device leaves the command
pending until it reconnects. SSH fallback is not implemented.

Commands are delivered serially on heartbeat. Re-detection refreshes the
reported agents. Restart/update wait until no threads are running. Update
runs the same global npm install and then restarts through the existing service
manager. The daemon persists a receipt before requesting restart, then reports
it after startup, preventing replay. A failed update does not restart the
service; failures become command receipts. `completedAt` records daemon
acknowledgment, not a promise of subsequent service availability.

Managed public npm installations also check for newer stable versions once per
day. Automatic updates wait for threads, Coordinator work and in-flight claims,
then stop admitting work until installation and restart finish. npm uses the
service's Node runtime and existing registry configuration. Checks and installs
run outside the heartbeat loop. `--no-auto-update` on `daemon service install`
persists an opt-out; foreground, development and embedded daemons are excluded.
Service installation preserves an explicit `--data-dir`. Updates preserve the
device credential and server configuration. Failed automatic attempts wait a
day before retrying and do not deliberately restart after installation failure;
the existing in-place npm replacement does not provide rollback.

## Verification

- Desktop host validation, explicit key confirmation, all progress steps,
  token secrecy and step-specific failures: `pnpm --filter @mikka/desktop test`.
- Service generation, update/receipt/restart ordering, failed update and grant
  exchange: daemon `service.test.ts` and `registration-login.test.ts`.
- Real PostgreSQL: `pnpm test:device-enrollment-db`, with an isolated loopback
  `E2E_DATABASE_URL` ending `_e2e`. Each run owns a disposable schema. The suite
  covers user binding, expiry, concurrent replay, owner isolation, cloud
  exclusion, command ordering and cross-device acknowledgment denial.
- `node tests/ssh-install/run.mjs` builds and packs a fresh daemon and drives
  the built preload through the real main IPC handlers. Electron's transport
  is mocked; SSH, the container host, npm installation, daemon and systemd are
  real. It checks untrusted-frame rejection, confirmation, online registration,
  re-detection, restart, changed PID and reconnection. The protocol server is
  a local test server; this is not production-account acceptance. The runner
  removes its disposable container and fixture directory. CI runs this in
  `.github/workflows/ssh-device-backend.yml`.

The cloud environment blocks direct registry access from containers. Local
acceptance can preload public npm package bytes with
`MIKKA_SSH_TEST_NPM_CACHE=<cache directory>`; this only affects the disposable
test runner. CI normally installs the packed tarball directly. The public npm
release still requires the trusted-publishing setup named in #491.

A real macOS launchd host, a successful update from the public npm release,
frontend screenshots and #504's remove flow require separate acceptance.

### Local acceptance record — 2026-10-30

- Source: branch `work`, base revision `68054f85`, with the #491 working-tree
  changes in this delivery. No remote CI run or production deployment is claimed.
- Cloud Linux source gates: complete `pnpm check` passed; desktop and daemon
  type checks passed; root and desktop lint passed; both bundles built.
- Focused results: 21 desktop tests, 14 daemon tests, 2 PostgreSQL tests and
  the packaged SSH/systemd acceptance passed.
- Runtime: a fresh privileged disposable Docker host built from
  `node:24-bookworm-slim`, image
  `sha256:11de6963139f8501012c4511b4e7a78e97f3c8da5cbd1746e8ca3190968ff4cc`.
  Database: isolated local PostgreSQL 17, `mikka_491_e2e`, with a disposable
  per-test schema. The test application was a local protocol fixture reached
  through SSH reverse forwarding; no production account or daemon was used.
- Verified the registered device ID, re-detection acknowledgment, a changed
  systemd service PID, re-registration and acknowledgment after restart.
  The final desktop lint cleanup was additionally checked with real child
  process success, failure and timeout tests and a rebuilt desktop bundle.

### Integration review against main `a367418b`

The integration review preserved main's locked device names and token revocation
on removal. It also fixed three concrete paths before merge:

- Removed-device command admission: occurrence 6/10 × impact 4/10 = 24.
  `removeOwnedDevice` retains a tombstone, so filtering only by owner and kind
  still queued unusable commands. Admission now excludes `removedAt` rows;
  PostgreSQL tests exercise the removed target.
- Reinstalling a running systemd unit: occurrence 7/10 × impact 6/10 = 42.
  `enable --now` leaves an already-running process on its old arguments even
  after the unit is rewritten. Installation now explicitly restarts the unit;
  SSH acceptance checks a changed PID on reinstallation.
- Receipt replay: occurrence 10/10 × impact 3/10 = 30. The daemon retains its
  last receipt across heartbeats; an unconditional UPDATE changed completion
  time every heartbeat. Completion updates now affect pending commands only;
  the database replay test verifies a stable timestamp.

Main's preload additionally marks the document's platform. The IPC fixture now
provides that minimal document surface; the post-rebase SSH acceptance passed
locally, including reinstallation. All 29 desktop unit tests passed after the
rebase. PR #511 carries the Git-linked CI evidence for the final revision.

### #540 verification — backend gaps batch

Branch `codex/backend-gaps-538-541`, cloud Linux. Desktop tests pass 32/32;
SSH parsing, key type, cancellation of actual child processes and retry are
covered. Desktop typecheck/lint pass. Packaged SSH acceptance passes through
real OpenSSH, systemd and daemon registration, redetect and restart; the built
preload also exercises host details and fingerprint cancellation/retry.
The disposable container uses the existing `MIKKA_SSH_TEST_NPM_CACHE` path
because this environment does not allow its direct npm registry connection.
No production host or user credential is involved.
