# Audit and account-data closeout (#210, #213)

Base: `375d670937ca06c53e47f336870481d38520c1fe`, cloud Linux.
This report records component evidence; it does not close either broad issue.

## Audit export

The previous CSV export stopped after reaching its cap and returned an ordinary
array without saying that later pages were missing. On real PostgreSQL a
controlled 121-row workspace returned 100 rows with a cap of 100, silently
omitting 21. The updated path refuses an oversized export with
`auditExportLimitExceeded`/HTTP 413, before publishing a partial file or receipt.
Occurrence 6 × impact 6 = 36: a successful-looking partial security export
omits incident evidence. The before/after probe is retained in
`/tmp/mikka-audit-cap-before-after.log`.

An export now reads a repeatable-read snapshot while holding the current
workspace-admin membership lease. It records the preparation in the existing
allowlisted audit table. Its manifest contains exact record count, ordered
record digests, UTC bounds and expiry. A separate workspace-database receipt
anchors those digests independently of the application event rows. This is
verifiable snapshot integrity, not a signature or a claim that an administrator
with access to both databases cannot rewrite them.

The existing authenticated CSV download keeps its format and gains export-ID,
count and SHA-256 headers. `format=json` returns a manifest, events and explicit
`nextOffset`; `exportId`, `offset` and `limit` resume the same snapshot. New
events cannot shift that snapshot. Each page checks current admin membership,
tenant, fifteen-minute link expiry and the anchored row hashes. Modified or
missing rows and reordered receipt entries return `auditExportChanged`/409.
Ordinary members and other tenants remain denied. Snapshot expiry does not
choose a retention/deletion policy for historical audit data.

Local isolated target: PostgreSQL 17,
`127.0.0.1:55599/mikka_audit_closeout_e2e`, 155 migrations including the new
workspace-target receipt migration. Existing databases/ledgers were retained.

- Real PG snapshot/resume/denial/tamper/failure tests: 7/7, no skips,
  `/tmp/mikka-audit-export-db.log`.
- Existing real PG audit query regression: 3/3, no skips,
  `/tmp/mikka-audit-query-regression.log`.
- Actual route-function adapter with explicit auth/service fixtures: 3/3,
  `/tmp/mikka-audit-route-final.log`. This is not full Next/session acceptance.
- Audit event contract source tests: 12/12; root TypeScript, targeted lint and
  diff checks passed. A parent integration build/HTTP-account-pool run and
  Git-linked CI still need to cover the final merged revision.

## Remaining scope

The existing event catalogue and member/token/secret writers remain in use.
Complete current authentication/denial/Agent-event coverage, cross-database
delivery recovery and explicit retention/legal-hold configuration still need
their full issue evidence. No historical-data cleanup policy or legal period
has been invented. Snapshot integrity does not silently promise immutable
storage or prove that a pre-snapshot event was never changed.

Account deletion currently needs a durable phase journal: its application
database commits before the workspace transaction finishes, and failed object
cleanup is only logged. The next component will preserve deletion intent,
cross-database progress and pending objects so retries and restore replay do
not claim unfinished work succeeded. Real provider/backup exceptions must be
listed rather than reported as deleted.

## Account deletion journal (#213)

The previous path committed the main store before the workspace store, then
logged and swallowed object-delete errors. A workspace failure could leave no
account available to retry; an R2 failure lost the only object references.
Occurrence 6/10, impact 8/10 (48): an ordinary provider/storage outage or process
restart after an acknowledged database commit takes this path. The owner-column
INSERT race is a privacy defect even on tables such as `user_facts` without a
user FK; its fix does not depend on a low likelihood score.

`account_deletion_jobs` now retains a content-free receipt outside the deleted
user's foreign-key cascade. Its phases are `preparing`, `requested`,
`external_pending`, `main_deleted`, `workspace_deleted`, `storage_pending`,
`completed` or `cancelled`. Main data deletion and its object list/phase commit
in one main-store transaction. Workspace deletion has a separate commit and is
idempotently replayable. No distributed atomic transaction is claimed.

The owner write barrier waits for in-flight managed file writes and INSERTs.
After request confirmation it rejects new owned INSERTs, including tables
without FKs; solo workspaces reject new memberships/content while pending.
A fresh workspace plan is checked while its row locks span main deletion and
workspace deletion, preserving shared issues/projects/group messages. An owner
can cancel only before external cleanup begins. Owner IDs, plans and object
keys are excluded from the public lifecycle receipt. The receipt UUID is a
private capability passed in a request header, never a URL; store it privately.
The backend POST takes the current human session and typed email, so device/API
principals cannot impersonate an account owner. The existing settings action
keeps its typed-email confirmation and reports pending cleanup rather than
reporting deletion success. New backend POST supports a client-kept request UUID
for lost-response recovery; its settings UI integration is still a dependency.

`GET /api/cron/account-deletions` resumes at most five jobs using the existing
cron workload secret. The existing minute worker must include this endpoint.
Database-only receipts remain queryable after the user/sessions disappear.
Capture upload grants must expire before final object cleanup; both staging
and verified keys are retained. Failed old-avatar cleanup retains its key.
Composio deletion enumerates all states with the trusted owner filter and
requests upstream revocation through the existing SDK adapter; provider data
contents are not deleted. BYOS custody artifacts and cloud runtimes without an
acknowledged teardown adapter explicitly block, preserving their mappings.

The restore adapter requires an independently retained **current** deletion
manifest, its protected digest anchor and an isolated explicit target pair.
`applyAccountDeletionManifest` rejects altered manifests and any unfinished
live job. Completed deletions replay the same local deletion path and saved
shared-data preservation decision; they do not redo remote provider effects.
A failed restore/object cleanup leaves recovery quarantined. Manifest SHA256
is corruption detection, not an authenticity or freshness proof. Backup-local
journals cannot prove that no deletion occurred after the backup.

### Data ownership and remaining policy/acceptance

| Assets | Purpose / current deletion treatment | Retention / outstanding boundary |
| --- | --- | --- |
| Main owner rows, sign-in/session/device/OAuth tokens, local vault envelopes | Owned service data; deleted in the main transaction, existing FK/dependency order retained | No invented legal retention period |
| Solo workspaces, membership, invitation, owned projects | Workspace commit; invitations matched using normalized email hash | Shared team issues/projects/group messages stay for remaining members |
| Artifact versions, captures, avatar and known retired avatar objects | Persist keys before removing DB pointers; retry acknowledged object DELETEs after upload grant expiry | Historical unreferenced bucket objects from failed PUT/database transactions need an independently verified bucket inventory/lifecycle policy |
| Composio connections | Owner-filtered list and managed authorization removal before local mapping deletion | Upstream revocation may be asynchronous; real provider acceptance still required |
| BYOS Infisical artifacts, native model state | Preserve mapping and report `subscription_custody_cleanup_required` | An owner-bound, acknowledged cleanup adapter is still required |
| Cloud sandbox files / run runtime | Report `cloud_runtime_cleanup_required` while managed resources remain | Owner-bound runtime teardown acknowledgment is required; user-device files are outside service custody |
| Audit rows, shared message authorship, immutable evaluation ledgers | Existing accountability/team records are retained, not silently rewritten/deleted | Explicit data minimization, legal hold and retention policy remains required; account deletion is not claimed to erase every actor reference |
| Deletion receipt and restore-suppression guards | Restore must not resurrect an erased account | Default `retentionUntil = NULL`; no destructive expiry without an explicit policy |
| Backups / provider-held logs and user-owned upstream contents | Recovery replays current tombstones before exposure; it never uses an old dump as proof of current deletion state | Backup expiry, independent storage custody, upstream retention and policy approval remain concrete deployment acceptance requirements |

Real PG17 component checks cover sole-admin refusal, owner-only cancellation,
external cleanup blocking, file retry, upload-grant delay, main/workspace commit
failure, a new pool resuming the committed phase, and concurrent no-FK INSERT
rejection. A second real PostgreSQL schema tests explicit restore targets,
altered/pending manifests, preserved peer data and post-replay suppression.
That schema fixture is not a complete backup/restore drill. Route adapters use
explicit module fixtures; they are not deployed Mikka HTTP/provider acceptance.
No customer data, real external authorization or production history was deleted.

Still required before closing #213: full fixed-revision app HTTP acceptance,
settings request/receipt status integration and fresh reauthentication policy,
complete portable export coverage (files/harness checkpoints), real BYOS/cloud
cleanup evidence, verified historical object inventory/lifecycle, current
manifest backup drill, and the explicit retention/hold/backup policy above.

## Explicit audit retention and hold (#210)

`workspace_audit_retention` lives beside the main audit sink, so each explicit
admin policy change and its audit record commit together. No row or NULL days
means retain. `legalHold` blocks cleanup. The backend API accepts only a human
session, a current active workspace admin, same-origin mutation and explicit
`{retentionDays: integer|null, legalHold: boolean}`; it never infers a period
from a product default or invents a legal policy. The numeric bound is a storage
validation bound, not a recommended legal retention period.

The existing cron workload can call `/api/cron/audit-retention`. It applies only
explicit non-held policies. Event deletion and its exact-count audit record
share one transaction; an audit failure rolls deletion back. A workspace lock
serializes export publication with cleanup, and any unexpired export receipt
postpones cleanup so resumable snapshots retain their promised data window.
Receipt digests/anchors are retained separately; their own destruction and any
legal retention mandate still require an explicit policy.

PG17 tests cover default retain, member/other-tenant denial, hold, policy rollback
on failed audit, scoped expiry/count, live-export delay, deletion rollback on
failed audit, and restoring NULL retention. Only disposable fixture history was
deleted. No production retention policy was selected or changed. Endpoint tests
are route fixtures; fixed-revision Mikka HTTP acceptance and the existing design
owner's policy/hold controls remain required. Cross-database member/permission
writes still use log-only `recordAuditSafe`; its durable event delivery and the
full event catalogue/failure paths remain concrete #210 gaps, so this component
work alone does not justify closing #210.
