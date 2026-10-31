# Approve and publish (#494)

The browser's existing `approve` operation now approves and starts the selected
publication. A live, provider-linked human session still supplies the approval;
request JSON cannot supply that identity.

## Transaction and execution

The approval row, approval-stage result, transition to publish, and publication
reservation commit in one transaction. A reservation write failure rolls all of
them back. The request fence is the owned `taskId` and current `revision`;
approval/lifecycle inputs accept old context fields but do not use them as CAS.
The server derives candidate, attempt and issue provenance for provider receipts.
Existing full-binding responses remain compatible with current clients.

The handler invokes the existing registered publication adapter using that
reservation. Before provider IO, the effect claim is committed using the existing
`uncertain` publication state. If execution is interrupted after that claim, a
retry must reconcile; it cannot issue another create request. Pending and unknown
outcomes retain the same publication ID. A confirmed provider failure returns the
same candidate to `approval/pending`; a fresh human approval may retry. Cancelled
or revoked tasks are never returned to approval by this recovery.

The old `publish` operation remains compatible: it consumes the reservation or
returns the recorded result. It cannot reserve a second publication for the same
approval. `reconcile` reads the existing operation and never repeats a provider
create. Existing ownership, Bot/source, exact candidate/action/target, STOP and
receipt verification checks continue to run.

## Legacy fields and frontend handoff

`expiresAt` is optional input and no longer grants or expires authority. Existing
columns and receipt metadata are retained without a destructive migration. A
new approval always has a reservation; it cannot enter a separate renewable
"approved but not published" state. Grant revocation after a reservation is
rejected; cancellation uses the task's existing STOP control.

The current frontend remains operational: its second `publish` after a successful
`approve` reads the same result, and a pending `approve` reloads the ledger and
exposes reconciliation. Shared state derivation no longer hides a reserved or
completed publication when the historical timestamp passes.

Frontend follow-up owned by the existing frontend workflow:

- Stop sending the second `publish` after `approve` and use the returned receipt
  or pending/reconcile response directly.
- Remove the old approval-expiry display and grant-revoke control. Task STOP and
  publication reconciliation remain available.
- Keep the display/provenance fields while clients consume them; they are no
  longer extra approval/lifecycle CAS fields.

No component layout, text catalogue, production migration, provider grant,
paid deployment or feature flag is changed here.

## Validation

Cloud Linux tests use the isolated PostgreSQL 17 container
`mikka-494-postgres` on loopback port 55494, disposable fixture databases and
schemas, real SQL transactions, and a real local filesystem publication adapter.
The HTTP authentication case uses real Better Auth with synthetic account/link
fixtures. Vercel calls are a loopback protocol fixture, not paid cloud
publication; upstream review/verify runs remain explicit harness fixtures.

New cases cover one-request approval, ten-way concurrent replay, reservation
SQL rollback, a lost response after the effect claim, confirmed failure and a
fresh approval retry, two-field requests, historical request compatibility and
pending HTTP reconciliation without a separate publish call. The existing
owner, permission, STOP, rollback, provider readback, malformed receipt and
session-boundary regressions remain enabled.

Relevant commands:

```sh
node --import ./scripts/server-test.mjs --import tsx --test lib/factory/approval.test.ts
node --import ./scripts/server-test.mjs --import tsx --test --test-concurrency=1 \
  lib/factory/approval.db.test.ts lib/factory/reject.db.test.ts \
  lib/factory/reject-store.db.test.ts lib/factory/public-consumers.db.test.ts \
  lib/factory/publication-failed.db.test.ts
node --import ./scripts/server-test.mjs --import tsx --test \
  lib/factory/contract.test.ts lib/factory/acceptance-state.test.ts \
  lib/factory/vercel-publication.test.ts
```

Database commands additionally require the explicit loopback test URLs and
opt-in variables documented by each fixture. These results do not claim live
provider/OAuth acceptance, a deployed application or rendered browser acceptance.
