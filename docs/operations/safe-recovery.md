# Isolated backup and recovery drill

Inventory: MIKKA_DATABASE_URL owns users/tasks/runs, approvals, operation and
audit ledgers, vault metadata and deletion tombstones. DATABASE_URL owns
workspaces/membership/projects and their receipts/guards. Uploaded artifacts,
captures, avatars and execution evidence need their object bytes as well as DB
references. Configuration, migration SQL and workload/vault key references
must be retained through the existing configuration system; database backups
do not contain a usable vault key or replace provider/KMS access.

`scripts/ops/isolated-recovery.mjs` is deliberately a small loopback PostgreSQL
17 drill tool. It verifies an existing Docker container's actual loopback port,
`*_e2e` database names, postgres fixture identity and no URL password or query.
The two source roles may refer to the same verified physical database; restore
targets must still be distinct, brand-new and different from every recorded
source name. It never targets production or allocates cloud resources. The
standard drill creates its own separate source databases, migrates through the
existing runner and retains every database and evidence directory.

Writers and workers must be stopped for both logical data domains and the
object copy. The backup holds share locks while exporting PostgreSQL snapshots
and copying data. For separate sources, two database snapshots are **not** a
distributed transaction; consistency depends on explicit quiescence. A live-production
snapshot/PITR and object-store version boundary require an approved provider
procedure. Do not infer one from a local successful dump.

Each database uses native custom-format pg_dump. AES-256-GCM encrypts the dump
and object payloads. The manifest binds exact source SHA, migration inventory,
per-table counts and canonical-row hashes, object keys/sizes/SHA-256 and every
encrypted file hash. Retain its expected digest and encryption key outside the
bundle in an existing protected store. Its self-declared hash alone cannot
prove integrity. Local source/evidence remain private; report no row content,
credentials, URLs or secret material.

Source topology is derived from the verified pair and bound into that same
manifest; there is no caller flag that loosens restore isolation. Source
aliases retain the existing main/workspace order and unique `database-0.enc`
and `database-1.enc` names. Both isolated restore copies then contain both data
domains, so current deletion replay and credential/approval/effect quarantine
run over both copies. A shadow copy must not retain a deleted user or usable
credential. Older manifests without topology retain their original separate-
source interpretation.

Before restore, obtain a fresh **current** account deletion journal separately
from the old backup, with an independently protected digest and observation
time. A supplied journal older than five minutes or containing unfinished
deletion work cannot authorize exposure. The restore reuses
`applyAccountDeletionManifest` with explicit restored main/workspace pools and
restored object deletion. It never repeats completed remote-provider cleanup.
A failed deletion replay keeps the restore quarantined.

Restore refuses an existing target database, missing/corrupt bundle,
mismatched source-migration inventory, wrong independent manifest anchor or
unavailable vault probe. Targets have PUBLIC CONNECT revoked, remain
unconnected to the application/workers, and all tables/objects are checked
against the manifest before current deletions replay. Old sessions,
verification/device codes, device/run/personal tokens, OAuth grants and cached
browser credential leases are invalidated; credentials are revoked and pending
approvals declined. Active schedules pause and executing operations become
uncertain. Existing successful receipts are preserved. Outboxes are not marked
artificially delivered and no provider effects are resent.

Blocked backup/restore attempts emit a fixed, privacy-safe failure event and
rethrow the original failure. A trusted `onFailure(notice)` adapter can send it
to the existing approved internal sink and must return true only after delivery.
The drill wires that adapter. A missing adapter is explicitly `not_configured`;
a failed delivery is `failed`, remains visible on stderr, and never authorizes
exposure or hides the original restore failure. No database URL, object path,
key or upstream exception text is copied into the event. This is an internal
failure signal, not an external paging integration.

PUBLIC CONNECT does not restrict the database owner or superusers: the local
drill uses that owner explicitly. Database URLs must remain private and no
application or worker may be pointed at these targets. Before any later
exposure, reconcile all durable outboxes, receipts and current revocations,
refresh the deletion journal, authenticate again and obtain fresh approvals.
BYOS/cloud/provider secret references require current-vault reconciliation;
this tool does not claim that restoring them is safe for immediate use.

Run against the already authorized local fixture:

```sh
OPS_POSTGRES_URL=postgresql://postgres@127.0.0.1:55599/postgres \
  node --conditions=react-server --import ./tests/support/server-only-loader.mjs \
  --import tsx scripts/ops/drill.mjs
```

Predeclared local drill targets are RPO ≤60 seconds and restore-command RTO
≤120 seconds. Measure backup-capture to simulated failure and actual restore
command duration; do not report them as end-to-end incident recovery or a
production guarantee. The drill makes a post-backup change, deletes an account
through the real durable deletion adapter, restores two full Mikka schemas,
checks unchanged tenant membership, task/run/approval/receipt data and object
hashes, and proves current deletion replay and credential/approval invalidation.
It exercises corruption, missing object bundle, schema/key dependency failure,
stale/pending deletion journal and existing-target refusal. Vault availability
is an explicit controlled local adapter, not a production KMS probe.

The test key exists only in memory and is zeroed on exit. The retained encrypted
bundle and manifest document this run but are not a reusable production backup.
A production procedure still needs an existing protected key store, backup
schedule/retention, vendor-specific object recovery, current revocation
journal, actual vault probe and approved target/exposure checks. The drill
uses real PostgreSQL and deletion code with controlled SQL business fixtures;
it does not replace authenticated application end-to-end acceptance or prove
cloud PITR, cross-region recovery, vendor access or production RPO/RTO.

The drill's recovery notification now follows repair of its own injected DB
fault records and a fresh `databaseSignals` query; it does not manufacture
recovery by supplying an empty alert list. The injected operation never called
a provider, so that fixture alone has definitive no-effect evidence. Do not
copy its SQL cleanup into handling of a real uncertain external operation.
Stopping an abandoned run must preserve its original start/completion history.
The live lease can recover while the missed dispatch still counts against the
15-minute SLO window. The report keeps those windowed alerts separate; it never
backdates a successful start to make the recovery notification green.

Each timing report retains its original source SHA. The latest isolated
restore measurements, the historical backdating defect and the corrected
real PostgreSQL fault matrix are recorded in
[old-ops-completion-211-214.md](old-ops-completion-211-214.md). Component evidence
does not replace the original authenticated application end-to-end acceptance.
