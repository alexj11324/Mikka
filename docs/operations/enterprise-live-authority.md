# Enterprise live metadata authority (#1608)

## Contract

Task, Artifact and Factory live frames contain identifiers and changed revisions. They require the same current Workspace and Enterprise authority as the corresponding read. An already open socket must stop receiving new metadata when an Organization starts requiring SSO, SCIM disables its user, or its native session/proof is revoked.

Organization Workspaces use a random 256-bit channel for each actual Auth session and Workspace. The browser/native ticket response keeps its existing `url`, `protocol` and `expiresAt` fields. Clients pass them through; they must not derive an Organization channel from a user or Workspace ID. Personal live identity remains available to a valid ordinary session.

This change uses the existing live transport. It adds no polling and changes no VM, daemon, model-provider or payment authorization contract.

## Persisted boundary and locks

`20261109035023_enterprise_live_session_authority.sql` explicitly targets `MIKKA_DATABASE_URL`, beside Auth. It adds capability rows and durable revocation receipts. There is deliberately no session/user foreign key: deleting a session must leave an undelivered revocation available for retry.

| Operation | Order and commit boundary |
| --- | --- |
| Ticket registration | Workspace/member lease, APP transaction, Org shared advisory, session shared advisory, fresh canonical Enterprise gate, capability insert. The session read is MVCC; no session row/FK lock follows the advisories. |
| Metadata send | Workspace/member lease, canonical gate for the capability's real session, APP capability row SHARE, bounded transport. No additional APP/WS checkout follows the final row lock. |
| Policy/provider change | Workspace administrative lease, APP Org exclusive advisory, session changes and native triggers, remaining capability revocations, one APP commit. |
| SCIM disable | The directory state, revocation intent, session-proof cleanup and capability revocation commit together in APP. Workspace delivery can fail without reopening the source. |
| Native session delete/proof withdrawal | Native session row, session exclusive advisory, capability revocation in the same APP transaction. The trigger never takes the Org advisory. |
| Directory/member outbox | The directory serializer and member work reuse a pinned WS transaction; APP queries release their checkout before callbacks. The directory APP receipt is written only after WS commit. Stable audit IDs make a lost receipt retry safe. |

The Org advisory label is `enterprise-live-org:<organizationId>`; the session label is `enterprise-live-session:<sessionId>`. Phone delivery uses the same registration locks and canonical gate. Callers that change session rows must do so before locking remaining capability rows: a native DELETE already owns its session row when its trigger starts.

A sender that already holds the capability SHARE lock may finish its bounded send. The authority change waits for that send before it can commit. After the authority commit, every later source read excludes the revoked capability, even if gateway delivery fails. A policy operation that hits its existing lock timeout fails; it must not report a successful policy change.

## First binding, detach and replay

Before the first Organization binding commits in WS, an APP transaction writes permanent revocation markers for its old owner/Workspace channels and revokes earlier capabilities. Ambient sends retain their WS lease, so the binding cannot overtake an already authorized send. If the WS commit subsequently fails, the marker conservatively keeps this scope on fresh session capabilities.

Detaching does not revive a former ambient channel. The old Organization's capabilities are retired; an eligible session can obtain a new capability under the current binding. The capability's expiry never exceeds its native session or the existing five-minute ticket lifetime.

Builtin upgrade/open checks the real session, persisted channel, current Workspace membership and canonical Enterprise gate. A concurrent revocation removes a registered opening socket before a delayed authorization result can resurrect it. The existing PostgreSQL gateway bus broadcasts opaque `live_revoked` messages to all connected replicas.

## Worker contract and coordinated release

The existing authenticated endpoint `POST /v1/live/:channel/push` accepts the strict control object:

```json
{"type":"live_revoked"}
```

It acknowledges with HTTP 200 and exactly `{"revoked":true}` after the Durable Object persists its tombstone. It closes existing sockets, ignores subsequent metadata on that channel, and rejects replay of an unexpired old ticket after hibernation or restart. Ordinary metadata arrays and device routes retain their existing formats.

The app and Worker changes ship in the same PR. Existing deployment order may briefly place the new app ahead of the Worker. An old Worker rejects the control; the APP source barrier stays closed, the receipt remains pending, and the affected capability receives a null ticket until delivery succeeds. This is a safe temporary interruption, not a completed deployment or an acceptance pass. Valid Personal channels continue to work.

After both deployments are ready, verify explicit control acknowledgement, existing-socket closure, old-ticket rejection and a fresh authorized SSO capability. The existing durable audit-maintenance timer and explicit Enterprise retry action retry pending controls. A native Auth commit wakes that same path through `scheduleSessionLiveRevocation`; no Worker network request runs inside the Auth transaction.

## Rollback

Preserve the migration, capability source checks and gateway tombstones while any Organization has used this feature. Do not roll the app back to ambient Organization fan-out, drop pending receipts, clear Durable Object tombstones or treat expiry alone as revocation. Reverting an unrelated release component is possible while retaining these boundaries.

If the paired Worker cannot accept controls, leave affected capabilities safely paused and retry/roll forward the Worker. Restoring a pre-control Worker together with an ambient app is not a supported rollback. No Stripe Price, charge or license grant changes are part of this release.

## Verification required on the exact public commit

The preparation checkpoint is source-only. It has not been compiled or executed; a tree/hash readback is not test evidence.

Use the final public commit and its matching lockfile/package sources, an isolated loopback database ending in `_e2e`, and `REQUIRE_DB=1`. `E2E_DATABASE_URL`, `MIKKA_DATABASE_URL` and `DATABASE_URL` must all point to that database. Apply all migrations, including the explicit APP target. Never point these tests at a shared or production database.

Run the registered `test:enterprise-db`, `test:live-db` and `test:device-gateway` suites, the builtin gateway suite containing `lib/builtin-gateway/gateway.test.ts`, root/API native typechecks, and targeted lint. The DB registry must include `lib/enterprise/live-authority.db.test.ts`; do not use a module mock for its authority checks.

The new PG suite uses the production APP and WS pools with `max: 1`. A separate fixture connection creates real competing PG transactions; it does not replace either production pool. It covers first binding, policy revocation across two gateway replicas, Task/Artifact/Factory metadata, a real blocked sender/revoker, failed SCIM WS delivery, failed APP receipt with idempotent retry, session deletion retaining its outbox, registration versus DELETE, and provider reset versus native DELETE. Personal identity and a fresh eligible capability are positive controls.

The actual workerd suite sends metadata over sockets, persists a revocation, restarts the local runtime with the same Durable Object storage, and rejects the old signed ticket. No external Worker or production credential is used. Record the exact public SHA/tree, zero-skip TAP results, native type/lint results, and the actual paired deployment identities before marking this boundary accepted.
