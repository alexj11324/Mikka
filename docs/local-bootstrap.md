# Local bootstrap

`scripts/dev/bootstrap-local.sh` sets up a fresh cloud Linux session (Ubuntu or
Debian, root or sudo) in one step. It is idempotent: the first run takes under
a minute, a second run only checks and takes about a second.

```sh
eval "$(scripts/dev/bootstrap-local.sh)"
```

It prints one `export` line, which `eval` applies to the shell. The disposable `e2e` role has a generated password in `/var/lib/mikka-dev/e2e-password` (mode 0600); the database URLs read it with `$(cat …)`, so the line itself carries no secret and the URLs pass `scripts/test-accounts`' `databaseTarget`. The line also sets `MIKKA_LOCAL_TEST_ACCOUNTS=1` (local test mode, [dev-workflow.md](dev-workflow.md)).
Run it without `eval` to see the line.

| Step | What it does |
| --- | --- |
| PostgreSQL 17 | Installs `postgresql-17` from the [PGDG apt repository](https://www.postgresql.org/download/linux/ubuntu/) when missing (no Docker), without the package's default cluster. Runs its own cluster in `/var/lib/mikka-dev/pg17` on `127.0.0.1:5432` (the port the DB suites assume), loopback only with trust auth, and creates `mikka_e2e`. |
| Node | The version in `.node-version` (a major such as `24`, or an exact `24.22.2`), else 24 as CI's `setup-node`. Uses `node` on PATH, or the image's `/opt/node<major>` (this cloud image puts `/opt/node22` first), when it matches; otherwise installs that release (the latest of a major) from [nodejs.org/dist](https://nodejs.org/dist/), checked against its `SHASUMS256.txt` ([verifying binaries](https://github.com/nodejs/node#verifying-binaries)). |
| pnpm | Enables pnpm at `packageManager` through [Corepack](https://nodejs.org/docs/latest-v24.x/api/corepack.html) and runs [`pnpm install --frozen-lockfile`](https://pnpm.io/cli/install). It runs again only when `pnpm-lock.yaml`, `package.json` or Node changed. |
| Sandbox tools | Installs `bubblewrap`, `socat` and `ripgrep` when missing. |
| Chromium (UI screenshots only; no browser tests run) | When the container has `/opt/pw-browsers/chromium`, exports `PLAYWRIGHT_BROWSERS_PATH` and `MIKKA_CHROMIUM_EXECUTABLE_PATH`. The Playwright configs pass the latter as [`launchOptions.executablePath`](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-executable-path), so a container whose Chromium revision differs from the pinned Playwright's needs no `playwright install`. Playwright supports only its bundled browsers, so a screenshot can differ from a newer Chromium. |
| Migrations | Runs `pnpm test:e2e:setup` (every `drizzle/` migration through `scripts/migrate.mjs`, then the auth tables) on `mikka_e2e`. It runs again only when a migration, that setup script or the lockfile changed. |

The export line sets `MIKKA_LOCAL_TEST_ACCOUNTS=1`, which also raises the local registration limits (`lib/abuse/signup.ts`, see `docs/dev-workflow.md`); nothing else needs setting.

It sets no CI variables. DB suites such as `test:run-publication-db` run
because `mikka_e2e` is a loopback `*_e2e` database; suites gated to hosted
GitHub Actions only still refuse to run locally.

Overrides: `MIKKA_DEV_HOME` (default `/var/lib/mikka-dev`), `MIKKA_PGDATA`,
`MIKKA_PG_PORT` (default `5432`).

## In the cloud environment's setup script

The environment's setup script can run it, so every new session starts ready:

```sh
scripts/dev/bootstrap-local.sh > /etc/profile.d/mikka-dev.sh   # from the repository root
```

The export line then loads in every login shell.
