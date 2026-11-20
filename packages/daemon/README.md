# Mikka daemon

The daemon connects your computer to Mikka and runs threads with its own pinned
Claude Code or Codex, installed when needed. Cursor is available on runners that
report support for its adapter. Node.js 22 or newer and Git are required. Runs use
the selected subscription or model credentials. Repository setup uses the task's
authorized GitHub credential or existing machine Git credentials.

On Linux the agent sandbox also needs `bwrap`, `socat` and `rg`. No root is
required: on Debian and Ubuntu the daemon fetches any that are missing from the
machine's signed apt sources into its data directory. On other distributions,
install them with the system package manager and the daemon picks them up by
itself. Settings > Devices names anything it could not resolve.

The published `@aspectlylabs/mikka` package contains the `mikka` command and its
daemon subcommands. The workspace package has `private: true`.
`pnpm --filter @mikka/daemon build` produces the package with the private
protocol bundled. The release workflow uses npm trusted publishing and verifies
the published registry metadata.

Install the public package and start the daemon.

```sh
npm install -g @aspectlylabs/mikka
mikka daemon login
mikka daemon
```

Login prints a browser confirmation link and a short code. The daemon
saves a device credential, never the browser session. The default server is
`https://app.aspectlylabs.com/mikka`. For a local or self-hosted server, use
the full application URL (including its base path) in both commands:

```sh
mikka daemon login --server https://mikka.example.com/mikka
mikka daemon --server https://mikka.example.com/mikka
```

`mikka daemon status` reports an already running daemon. `Ctrl+C` shuts it down.
Manual test setup can use `mikka daemon login --token <device-token>`; keep the
token out of screenshots, logs and shell history.

For background operation, install a service after signing in:

```sh
mikka daemon service install --server https://app.aspectlylabs.com/mikka --device-type laptop
```

## The device session

The daemon works only while it holds one WebSocket to the server's device
gateway (decision `docs/design/decisions/2026-11-17-2215-device-session-no-heartbeat.md`).
The open socket is the device's session: it is how the server knows the device
is online and that its runs are alive. There is no heartbeat and no fallback.

- The daemon registers, takes a gateway ticket and opens the socket. It pings
  every 10 seconds and drops a socket that has said nothing for 30 seconds.
- When the socket opens, and on every `work` push, the daemon reads once: run
  messages and stops, device commands, repository settings and queued runs. It
  then claims queued runs, delivers buffered run output and resumes runs.
- When something changed (harnesses and models, device commands it finished,
  a failed update, quotas), and once after each socket opens, it sends one
  report. The report renews nothing.
- A dropped socket is redialed after 0.5 seconds, then 1, 2, 4 and so on up
  to 30 seconds, with jitter. A socket that stayed open for a minute resets
  the wait. While the socket is down the daemon only redials: it does not read
  commands, run controls or reviews, and claims nothing.
- A run keeps running while the socket is open. When the socket drops, the run
  may go on for 60 seconds; if no socket opens in that time, the daemon stops
  it as `device_lost`.
- A server without a gateway has no devices. The daemon asks for a ticket again
  every 30 seconds and does no work until the server has one.
- A cloud worker asks for its next token once, an hour before the current one
  expires.

The daemon's local timer checks run deadlines and the watchdog, rescans agent
CLIs every 5 minutes and asks them for models every 6 hours. It sends nothing
unless the result changed and the session is open. Run checkpoints are sent
only when a run's work changed.

## Updates

A daemon older than the server's minimum gets `426 daemonUpgradeRequired` on
every request, and the gateway closes its socket with code `4001`. The daemon
then stops connecting and claims no work; `mikka daemon status` shows
`"session": "update_required"`. Update it with
`npm install -g @aspectlylabs/mikka@latest` (or update Mikka Desktop), then sign
in again if asked.

For public npm installations running under launchd or systemd, updates are
automatic. The server names a newer stable release in a report answer or a
commands read; a daemon the server refused installs the release named in the
refusal, or else npm's `latest`. The daemon installs that exact version when no
run is active. A failed install keeps the running version, waits 5 minutes,
then 30 minutes, then 2 hours before retrying that version, and is reported to
the server by code. Running work drains before installation and restart.
The service keeps its server, data directory and device identity. Foreground,
development and embedded daemons do not update themselves.

Add `--no-auto-update` when installing the service to disable automatic updates.
The setting is saved in the service definition. Manual updates remain available
through Mikka. An installation failure does not request a restart. npm replaces the global
package in place, so an interrupted installation has no automatic rollback.

## Build a release package

```sh
pnpm --filter @mikka/daemon build
export MIKKA_DAEMON_DIST_DIR=/absolute/path/printed/by/the/build
pnpm --filter @mikka/daemon test:package
npm pack "$MIKKA_DAEMON_DIST_DIR"
```

Each build writes a new `.retained-build-*` directory in the source package.
Existing builds remain intact. The package test requires that exact directory
and retains its `.retained-package-test-*` installation, tarball and fixture
index for inspection. The test daemon still performs its normal lifecycle
cleanup inside the new dedicated fixture; previously retained resources are
not part of that fixture.

No global `tsx` or separate `@mikka/protocol` package is needed. The MCP
connection-check client and its JavaScript dependencies are also bundled;
the build appends their complete upstream licenses to `THIRD_PARTY_NOTICES.md`.
SDKs that need native binaries or runtime assets remain external dependencies.
A push to `main`
that changes the daemon, the protocol, shared config, the lockfile or the
release scripts publishes through `.github/workflows/publish-daemon.yml` after
daemon checks and the installed-package runtime test pass. The workflow uses npm
trusted publishing and provenance; its npm trust configuration must authorize
this exact repository and workflow filename.

CI stamps `0.0.<workflow run number + 1>` into the source manifest before the
build, so the npm package and runtime report the same version. Source commits
keep their development version. Re-running a workflow keeps its version and
skips publication if npm already records that version from the same commit.
CI writes the commit SHA into the published manifest as `gitHead`; an existing
version with absent or different commit metadata stops the release. After
publication, CI reads npm metadata back and checks the commit SHA. If npm
serves 404 while the published version becomes available, CI checks up to 31
times with 10-second waits. Exhausting that wait reports registry verification
as incomplete; it does not claim that npm rejected publication.
Releases queue without cancellation (up to GitHub's 100 pending-run limit).
An older run can publish under its own `build-<version>` tag, preserving the
newer `latest` version. Manual dispatch remains available on `main` and gets
a new run version. Running local tests or builds does not publish anything.

`test:package` installs the actual tarball into a new directory with public
registry dependencies, without workspace symlinks or install scripts. Plain
Node then runs the installed CLI and bundled mock daemon through a real
clone/worktree/verification/commit/push against a disposable local bare origin.
It verifies the pushed file and preserves the personal checkout. The test logs
the tarball digest; its control plane and model are explicit in-memory fixtures.
The installed daemon also starts a local STDIO MCP fixture, discovers its tools
without invoking them, and returns a receipt with credential values redacted.
This is not real Claude Code/Codex, native-helper, live GitHub App or production
device-authorization acceptance.
