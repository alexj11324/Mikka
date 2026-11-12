# Self-hosted stable releases and upgrades

Mikka has one backend source and two deployment editions. A source change does
**not** require a second self-hosted implementation. CI builds the community
image from main and tests it with disposable PostgreSQL, an API/CLI acceptance
driver and packaged Desktop. Main publishes a SHA image and the moving
`latest` tag, but existing installations are **not** automatically restarted.

## Stable channel (no silent main/latest upgrades)

To promote a version, create or update `config/self-hosted-stable-version`
with a new `vMAJOR.MINOR.PATCH` in a reviewed PR. An explicit stable tag on an accepted
main commit can also initiate promotion. Ordinary merges publish the SHA image
and `latest`. Desktop releases use a separate tag series.

Promotion requires successful main source CI and the successful image job for
that exact commit. CI reads GHCR's digest for the image job/attempt tag and the
commit tag, checks the digest-pinned image's OCI revision and verifies the
release tag against the same commit. The GitHub release records the digest,
commit, migration fingerprint and tested desktop protocol range. The host
pulls that digest and independently checks the revision and migrations. A
repeat release with a different manifest or digest fails closed.

When shipping new migrations, first merge the source and let the self-hosted
image workflow publish its tested main SHA. Verify that digest is available
from GHCR. Then open the version promotion PR on the same migration inventory.
The release drill needs two real, previously published installations. The
first has the new schema and can return to its previous image after a failed
probe. The second has the older schema and must recover forward after a
migration. This sequence also applies to the first stable version.

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
it is an example, not an announcement that this tag exists. Before acknowledging the drain, close admission to new work at your gateway.
The updater then queries the installation's own `agent_runs` table. Queued,
preparing, running, paused, waiting-input and finishing runs block shutdown.
Allow the worker to report completion, then repeat the command.

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
the stopped application's `/data` volume. For bundled PostgreSQL, the
updater streams the `mikka` database to a private `postgres.dump` archive,
restores it into a new database created from `template0`, and drops that
verification database. It accepts the archive only if the full restore passes.
Reserve space for the archive, restored database and app-data copy. Back up
custom PostgreSQL roles, tablespaces or additional databases separately.

To verify a backup independently of an upgrade, run the same host entry point:

```sh
node scripts/self-hosted-update.mjs backup
```

To inspect a retained archive, start a separate disposable PG17 installation
and use its Compose project directory for both commands below. Supply the
private archive path printed by the updater and check known application rows.

```sh
docker compose exec -T postgres createdb -U mikka -T template0 mikka_restore
docker compose exec -T postgres pg_restore -U mikka --exit-on-error \
  --single-transaction -d mikka_restore < /path/to/private/postgres.dump
```

For managed Neon/PostgreSQL the updater **requires a working backup hook**:

```sh
MIKKA_UPDATE_COMPOSE_FILE=docker-compose.neon.yml \
MIKKA_EXTERNAL_DB_BACKUP_HOOK=/absolute/path/to/create-and-verify-neon-snapshot \
  node scripts/self-hosted-update.mjs apply v1.2.3 --ack-idle
```

The executable receives a private backup directory as its sole argument.
It must create/verify a recoverable provider snapshot or restore point, and
must exit nonzero if it cannot guarantee one. A dummy `exit 0` is **not**
a safe backup. The updater does not assume a Neon backup exists just because
the database connection works.

### Schema migrations and recovery

The updater compares the complete migration inventories of the running image
and the verified release. If any file differs, automatic activation stops.
Review the DDL and the expand/contract boundary, verify the backup or PITR
point, drain work, then apply the release manually:

```sh
node scripts/self-hosted-update.mjs apply v1.2.3 --ack-idle --allow-migrations
```

The application runs migrations under its session lock. The host checks the
installed revision, community desktop discovery, database readiness and sign-in
through the candidate's local API. Set `MIKKA_UPDATE_VERIFY_HOOK` to an
absolute executable path to run site-specific checks after these pass. It
receives the target tag and must return nonzero on failure.

| Outcome | Controller action | Operator action |
| --- | --- | --- |
| A run is active | Leaves the old application running | Let the task finish and repeat the upgrade |
| Candidate fails, migration inventory unchanged | Restarts and health-checks the previous image, persists its pin, retains the private backup | Inspect the failing probe before retrying |
| Candidate fails after migrations could have run | Keeps the candidate, backup and `recovery.json`; a configured drain remains active | Repair forward and verify the data before reopening writes |

For forward recovery, keep admission closed. Fix the configuration or select
a corrected **published** release at or above the attempted version. Use the
original Compose file and the same trusted drain, idle and verification hooks.
The recovery command validates the manifest, digest and database state, starts
the selected image, runs the health/API and operator probes, records success
and reopens the managed drain. An additional migration inventory change also
requires `--allow-migrations` and a fresh verified backup.

```sh
node scripts/self-hosted-update.mjs recover v1.2.3 --ack-idle
```

Backups and `last-success.json` are under `MIKKA_UPDATE_STATE_DIR` (default
`.mikka-updates`). If the host loses power, verify no updater is running
before clearing a stale `upgrade.lock`. Inspect the recovery record and
retain the last known-good image, snapshots and database until the repair
is checked. Unset any exported `MIKKA_IMAGE` when starting Compose so the
verified digest in `.env` takes effect.

## Receive upstream releases on an independent installation

A host operator can subscribe to GitHub release notifications with an ordinary
GitHub account. Open the upstream repository, choose **Watch → Custom →
Releases**, and enable email for watched repositories in the account's
notification settings. Route those messages to a dedicated local mail alias.
[GitHub notification settings](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications#configuring-your-watch-settings-for-an-individual-repository)

1. Install Python 3 on the mail-delivery host and Node.js 24 on the Docker host.
   The example runs both processes on one machine. Store a random 32-byte or
   longer ASCII secret in a private file readable by the delivery user and
   controller. Grant Docker access only to the host updater user. For example,
   create the secret with `umask 077; openssl rand -hex 32 > /etc/mikka/release.key`
   and set its owner/group according to the service accounts.
2. From the Compose project directory, run the receiver under a service manager
   configured to restart it after host restarts. For example:

   ```sh
   export MIKKA_UPDATE_WEBHOOK_SECRET="$(cat /etc/mikka/release.key)"
   export MIKKA_UPDATE_POLICY=notify
   node scripts/self-hosted-update-webhook.mjs
   ```

3. Configure the local MTA to pipe the original MIME message into the adapter.
   For a Postfix local alias, add the following line to the active aliases file
   and run `newaliases`. Replace the example path with the checkout's location.

   ```text
   mikka-releases: "|/usr/bin/python3 /opt/mikka/scripts/self-hosted-release-mail.py --secret-file /etc/mikka/release.key"
   ```

   Forward upstream GitHub release notifications to that address. The mail
   delivery user needs read/execute access to the adapter and key. Keep normal
   email filtering and sender authentication enabled. The adapter sends only
   the version tag to the loopback receiver on port 37499, using HMAC-SHA256.
   It decodes both text and HTML MIME parts. The controller looks up the tag
   on the fixed upstream GitHub HTTPS API and validates the published stable
   manifest. Email metadata cannot choose an image, revision, registry or
   command. Delivery failures return `EX_TEMPFAIL` (75), allowing the MTA to
   retain and redeliver the message. GitHub notification delays and mailbox
   outages delay discovery. The host never periodically fetches releases.

An existing, directly configured GitHub upstream webhook can also send signed
`release.published` messages to `POST /self-hosted-release` via a TLS reverse
proxy. Arbitrary subscribers can use the email route without upstream write
access, an incoming public HTTP listener or a managed Mikka relay. Both routes
share the same private release record and duplicate suppression. The app
container receives neither the HMAC secret nor Docker access.

### Policies and maintenance windows

| Policy | On a verified delivery |
| --- | --- |
| `manual` | Ignore the event. Apply a chosen stable tag through the CLI. |
| `notify` (default) | Write `.mikka-updates/pending-release.json` and log the tag. |
| `auto` | Queue the latest verified tag and submit it to the normal updater once eligible. |

Set `MIKKA_UPDATE_WINDOW_UTC=23:00-01:00` to restrict automatic starts to a
daily UTC interval. The start is inclusive and the end exclusive. An empty
setting allows any time. A queued release arms one local deadline, survives
receiver restarts and is rechecked at that deadline. A newer eligible release
supersedes older queued work. A duplicate or older tag cannot trigger another
attempt. Changing to manual/notify and restarting the receiver cancels its
pending automatic start. A window restricts when an upgrade starts; a running
upgrade may finish after it closes.

For automatic upgrades set both executable hooks:

- `MIKKA_UPDATE_DRAIN_HOOK` receives `enable` to stop new tasks/writes and
  `disable` to reopen traffic. Keep internal health-check routes reachable.
- `MIKKA_UPDATE_IDLE_GUARD` checks authoritative active task/run state and
  exits zero only once all active work has finished. An absent or failing
  guard blocks the upgrade.

A successful manual stable upgrade establishes the unattended baseline. For
a legacy installation already running an official GHCR image, run this
command once on the host to enroll the currently installed digest:

```sh
node scripts/self-hosted-update.mjs enroll
```

Enrollment pulls and checks the official digest and records its revision
and migration inventory in `enrolled-image.json`. It pins the running
image in `.env` and leaves the container running. Before the first automatic
upgrade, the host checks that this exact image is still active and GitHub
confirms its revision is an ancestor of the published release. A schema
change still requires a manual upgrade.
The host updater checks the release, digest, hooks, schema and backup
requirements on each attempt. Unattended migrations require operator review.
Inspect the host log, `pending-release.json` and `last-success.json` together.
`processed` means the updater exited successfully. `failed` records its error
code. After an interrupted `applying` attempt, inspect the actual container,
revision, lock and snapshots before resuming manually. The controller does
not replay a failed or interrupted attempt. To pin the current digest,
choose `manual` and restart the receiver; the installed digest remains in
`.env`. Resume by enabling the desired policy and applying any previously
skipped tag explicitly.

Custom orchestrators may receive release notifications the same way, read
the stable manifest and deploy its verified digest through their native
drain, backup, migration and health-check facilities. The bundled updater
operates only on its supported Compose layouts.

## CI and forward compatibility

The Docker image gate exercises local PostgreSQL 17, the published external
Compose file against a separate PostgreSQL 17 server and a PgBouncer
transaction pool, and authenticated RPC requests from protocol 0, 1 and an
unsupported client. The external fixture restricts DDL to the direct database role and checks
actual query counts on the transaction pool. It uses disposable
credentials and does not contact live Neon. The same candidate also runs
daemon, mail, object storage, model, restart and packaged Desktop acceptance.

For each added backend module, added exported capability, migration or newly
read environment variable, add an entry keyed by its source path to
`config/self-hosted-requirements.json`. Each entry records `mode` (`built-in`,
`operator-configured`, or `optional-cloud`), `environment` (variable names),
`behavior` (the operator-visible behavior or fallback) and `test` (an actual
test path). The image job executes the affected tests in community mode. For
a test using a custom runner, also set `suite` to a `test:...` package script
which executes that file. Stable releases rerun every declared test. The CI
source comparison checks the declaration, environment names, new hard-coded
hosted origins and test path. Declared PostgreSQL tests run with a separate
loopback PG17 cluster and a fresh database whose name ends in `_e2e`.
The Docker gate executes the installation
acceptance separately. An irreversible migration always requires the
operator's manual review and verified recovery point.

See [self-hosting](self-hosting.md), [self-hosted acceptance](self-hosting-acceptance.md),
and [dependency-aware CI](ci/incremental.md).
