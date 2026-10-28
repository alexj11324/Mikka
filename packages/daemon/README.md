# Mikka daemon

The daemon connects your computer to Mikka and runs threads with your installed
Claude Code or Codex. Node.js 24 or newer and Git are required. Sign in to the
coding CLI and make sure your local Git credentials can read the repositories
you want to use.

The public npm name and release trigger are awaiting Alex's confirmation. The
source workspace stays private; `pnpm --filter @mikka/daemon build` produces a
publishable `dist/` package containing JavaScript and the bundled private
protocol. Set `MIKKA_DAEMON_PACKAGE_NAME` to the approved npm name when building.

After installing the published package:

```sh
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

## Release candidate

```sh
pnpm --filter @mikka/daemon build
pnpm --filter @mikka/daemon test:package
npm pack ./packages/daemon/dist
```

No global `tsx` or separate `@mikka/protocol` package is needed. The proposed
release workflow uses npm trusted publishing from GitHub Actions, with npm
provenance. It is manual and must be configured for the approved package before
it can publish. Running tests or building a package does not publish it.

`test:package` installs the actual tarball into a new directory with public
registry dependencies, without workspace symlinks or install scripts. Plain
Node then runs the installed CLI and bundled mock daemon through a real
clone/worktree/verification/commit/push against a disposable local bare origin.
It verifies the pushed file and preserves the personal checkout. The test logs
the tarball digest; its control plane and model are explicit in-memory fixtures.
This is not real Claude Code/Codex, native-helper, live GitHub App or production
device-authorization acceptance.
