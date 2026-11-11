# Self-hosted stable releases and upgrades

Mikka has one backend source and two deployment editions. A source change does
**not** require a second self-hosted implementation. CI builds the community
image from main and tests it with disposable PostgreSQL, an API/CLI acceptance
driver and packaged Desktop. Main publishes a SHA image and the moving
`latest` tag, but existing installations are **not** automatically restarted.

## Stable channel (no silent main/latest upgrades)

The self-hosted image workflow publishes a stable GitHub release only for a
`vMAJOR.MINOR.PATCH` tag that points into main, after that exact image has
passed its Docker acceptance and been pushed to GHCR. Its release notes embed
the exact source revision, the complete migration inventory fingerprint and
the desktop protocol range. The host updater accepts **only this verified
release**, pulls the matching image, compares its OCI revision label and
migration fingerprint, and pins the content digest, never a mutable tag.

Mikka's existing Desktop releases use different tags and never trigger the
self-hosted update path. A regular `main` merge makes a new image available
but does **not** create a stable release or push an upgrade to servers.

## Host-side CLI

Install Node.js 24 and Docker Compose on the **Linux host**. Keep a checkout of
Mikka containing `scripts/self-hosted-update.mjs` and
`scripts/self-hosted-update-policy.mjs` alongside `.env` and the Compose
file. Run from that directory, not inside the application container:

```sh
node scripts/self-hosted-update.mjs check v1.2.3
# Confirm no Agent tasks are running and stop new task submissions first.
node scripts/self-hosted-update.mjs apply v1.2.3 --ack-idle
```

Replace `v1.2.3` with an **actually published** self-hosted stable release;
it is an example, not an announcement that this tag exists. The manual
`--ack-idle` flag is a positive operator assertion; without it, the updater
refuses to stop the application.

The updater runs on the Docker **host** and does not expose Docker's socket to
Mikka. It refuses unknown/movable images, missing release metadata, an unknown
installed revision, concurrent invocations and unsafe Compose layouts. It
only handles `docker-compose.yml` by default. For external Postgres:

```sh
MIKKA_UPDATE_COMPOSE_FILE=docker-compose.neon.yml \
  node scripts/self-hosted-update.mjs apply v1.2.3 --ack-idle
```

Use `MIKKA_UPDATE_STATE_DIR` to place private backup/snapshot records on a
disk with enough space. Backups include the existing `.env` and a copy of
the stopped application's `/data` volume. For the bundled PostgreSQL,
`pg_dumpall` creates a local SQL backup *before* the new image is activated.
Never run a database restore against a live application. Test restores in a
**separate** installation and follow PostgreSQL's recovery procedures.

For managed Neon/PostgreSQL the updater **requires a working backup hook**:

```sh
MIKKA_EXTERNAL_DB_BACKUP_HOOK=/absolute/path/to/create-and-verify-neon-snapshot \
  node scripts/self-hosted-update.mjs apply v1.2.3 --ack-idle
```

The executable receives a private backup directory as its sole argument.
It must create/verify a recoverable provider snapshot or restore point, and
must exit nonzero if it cannot guarantee one. A dummy `exit 0` is **not**
a safe backup. The updater does not assume a Neon backup exists just because
the database connection works.

### Schema migrations and recovery

If the old image and stable release have different **any** migration file,
an unattended upgrade **refuses** to proceed. A human must review forward
compatibility, verify backups/PITR and opt in:

```sh
node scripts/self-hosted-update.mjs apply v1.2.3 --ack-idle --allow-migrations
```

The new app runs its existing migration ledger and session-level advisory
lock at startup. The updater never rolls the database backward. If an upgrade
with possible DDL fails, it retains the snapshots and reports that **manual
recovery is required**. For migration-free failed upgrades it attempts to
restart the previous image, retaining the same volumes. An application
rollback is **not** a database rollback. Do not delete backup directories
until the installation has been checked and a separate restore is proven.

`/mikka/api/version`, the community server info, sign-in and desktop
discovery are exercised after deployment through the existing
`self-hosted-smoke.mjs`; a pass on these checks is not proof of a real
subscription run. The update writes a pinned `MIKKA_IMAGE=...@sha256:...`
into `.env` only after taking a private copy of its previous contents.
If an operator exports `MIKKA_IMAGE` in the shell, unset it when later
starting Compose so it cannot override the pinned value.

## Optional event-driven notifications / unattended updates

The host can run `scripts/self-hosted-update-webhook.mjs` on
`127.0.0.1:37499`. It accepts only an HMAC-SHA256 signed GitHub
`release.published` event for the upstream Mikka repository, checks the
stable release marker and stores the latest notification in
`.mikka-updates/pending-release.json`. Default policy is `notify`, never
`auto`. No periodic GitHub/registry polling is introduced.

For policy `auto`, configure **both** executable hooks below:

- `MIKKA_UPDATE_DRAIN_HOOK`: takes `enable` to reject **new** tasks/writes
  at the trusted edge, and `disable` to reopen traffic. Keep an internal
  health-check route reachable while drained.
- `MIKKA_UPDATE_IDLE_GUARD`: checks authoritative live task/run state and
  exits **0 only when all active work has finished**; an absent or failing
  guard blocks the upgrade. Do not replace it with a fixed successful exit.

The controller calls these hooks again **on each upgrade**, before it stops
the existing app. It never interrupts a running task merely because a new
release was published. Even with hooks, migrations are not unattended.

```sh
# Generate and store a private 32+ byte random webhook secret outside the repo.
# The host process needs limited access to Docker (effectively root privileges).
MIKKA_UPDATE_POLICY=notify \
MIKKA_UPDATE_WEBHOOK_SECRET=... \
node scripts/self-hosted-update-webhook.mjs
```

Bind only to loopback and place an HTTPS reverse proxy at the edge. Forward
`POST /self-hosted-release` to the receiver without altering its raw body.
Configure the matching secret in the trusted GitHub release webhook sender.
**Important limitation:** arbitrary Mikka self-hosters cannot configure
webhooks on Mikka's upstream GitHub repository. They need an explicitly
trusted, operator-controlled signed delivery/relay; do not mistake this
receiver for a globally deployed event delivery service. Until such a relay
is available, use the safe CLI and release notifications manually. This is
separate from the optional managed realtime relay tracked in #1570.

`manual`, `notify`, and `auto` are policy values; `notify` is the
default. The webhook response only acknowledges receipt, **not** a successful
upgrade. Check host logs, `last-success.json`, the running revision and
the service health afterward. No GitHub webhook or Docker control endpoint
is exposed by the application container.

## CI and forward compatibility

The image workflow exercises disposable community deployment, migrations,
restart, daemon registration, local SMTP/S3/model transports and packaged
Desktop. It also runs tests for signed release parsing, strict image pinning,
schema compatibility, idle/drain gates and safe dotenv updates. These checks
run for changes selected by the trusted Nx CI policy and every stable tag;
they do not claim that all future features are automatically compatible.
If a new feature adds a hosted-only dependency, a new migration, or a
different client protocol, update the self-hosted contract and its
acceptance tests **in the same PR**. Never silently replace the migration
review requirement or bypass a red test to publish a release.

See [self-hosting](self-hosting.md), [self-hosted acceptance](self-hosting-acceptance.md),
and [dependency-aware CI](ci/incremental.md).
