# Mikka daemon

The daemon connects your computer to Mikka and runs threads with your installed
Claude Code or Codex. Node.js 24 or newer and Git are required. Sign in to the
coding CLI and make sure your local Git credentials can read the repositories
you want to use.

The release candidate is a single `@aspectlylabs/mikka` package containing the
`mikka` command and its daemon subcommands. The source workspace stays private;
`pnpm --filter @mikka/daemon build` produces the package with the private
protocol bundled. The npm organization and trusted publisher must be verified
before publication.

Once the package has been published, install it once and start the daemon:

```sh
npm install -g @aspectlylabs/mikka
mikka daemon login
mikka daemon
```

Login prints a browser confirmation link and a short code. The daemon
saves a device credential, never the browser session. The default server is
`https://app.aspectlylabs.com/mikka`. For a Preview or self-hosted server, use
the full application URL (including its base path) in both commands:

```sh
mikka daemon login --server https://preview.example/mikka
mikka daemon --server https://preview.example/mikka
```

`mikka daemon status` reports an already running daemon. `Ctrl+C` shuts it down.
Manual test setup can use `mikka daemon login --token <device-token>`; keep the
token out of screenshots, logs and shell history.

For background operation, install a service after signing in:

```sh
mikka daemon service install --server https://app.aspectlylabs.com/mikka --device-type laptop
```

Public npm installations running under launchd or systemd check for a newer
stable release once per day. The daemon finishes its running threads and
Coordinator work before installing the exact version and restarting. Version
checks and installation run in the background so heartbeats remain available.
The service keeps its server, data directory and device identity. Foreground,
development and embedded daemons do not update themselves.

Add `--no-auto-update` when installing the service to disable automatic updates.
The setting is saved in the service definition. Manual updates remain available
through Mikka. Failed checks or installations wait until the next daily check;
an installation failure does not request a restart. npm replaces the global
package in place, so an interrupted installation has no automatic rollback.

## Release candidate

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

No global `tsx` or separate `@mikka/protocol` package is needed. Every push to
`main` publishes through `.github/workflows/publish-daemon.yml` after daemon
checks and the installed-package runtime test pass. The workflow uses npm
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
This is not real Claude Code/Codex, native-helper, live GitHub App or production
device-authorization acceptance.
