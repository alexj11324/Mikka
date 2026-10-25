# Security audit backend (#210)

This draft implements backend controls on frozen #257 `20e2f2e4ed14a9b08b3ef02fb56199809e29558e`, with main `40cbaff439dae444dd3f97729a7df450d7ec7b58` as the production reference. It requires the candidate's Factory, operation ledger, mailbox, credential and BYOS schema. It does not modify the source branch, merge, publish, apply production SQL, provision IAM, read real grants or redesign the frontend. Deployment and production acceptance remain coordinator-owned gates. This document is an implementation/acceptance contract, not a completion claim.

## Storage and threat model

Two additive migrations install audit tables/functions in their existing matching databases:

- `20261025170000_security_audit_application.sql`: application/auth/worker/Factory/credential/BYOS/operation sources.
- `20261025170001_security_audit_workspace.sql`: membership/invitation sources.

The existing runner applies each target separately. Reapplication preserves events. Each database has a persistent `storeId`; when deployments use one physical database for both targets, consumers deduplicate by `storeId` and `(tenant,seq)`. Do not sum duplicate logical source labels. Split targets use independent snapshots; there is no distributed atomic commit or globally simultaneous cross-database snapshot.

Audit capture is in the source transaction, not an in-memory queue. An audit persistence/validation error aborts that business write. External actions retain the candidate's existing reservation/uncertain/reconciliation semantics: a remote effect and a local DB commit are not atomic. An unavailable audit writer must not be interpreted as a successful/known external outcome. No remote side effect is replayed by this feature. HTTP refusal capture happens before returning its response; failed capture returns an unavailable/error response.

Each tenant has serialized sequence/hash allocation, immutable event records, UTC occurrence time, schema version and an allowlist of bounded non-secret references: actor type/ID, subject/resource, action/outcome/fixed reason, and applicable run/operation/server-generated request ID. Raw request bodies, emails, passwords, tokens, IPs, prompts, source error strings, provider bodies, repository paths and credential storage references are excluded. DB validation rejects extra fields and non-string/null values. An opaque actor credential **record ID** is a reference, not its bearer value.

The SHA-256 chain hashes the previous digest, newline and stored canonical JSON bytes. Verification checks sequence continuity, canonical data, timestamps, payload hashes, the retained prefix checkpoint and current head. It detects the controlled single-row edit/deletion/reordering cases in tests. Ordinary UPDATE/DELETE on retained events is rejected. This is **tamper detection, not tamper-proof/WORM storage**: a database owner can disable triggers or rewrite the entire chain/head/checkpoints. Privileged database compromise requires a separately controlled backup/checkpoint trust domain. No external backup service is purchased or configured here. No SOC2 or legal compliance certification is implied.

## Event coverage and attribution

| Source | Capture | Tenant/actor |
| --- | --- | --- |
| Better Auth session create/delete | login/session revocation in source DML transaction | personal owner; authenticated user ID; no session token |
| Auth POST and MCP HTTP failures | fixed action/status only | anonymous/system auth stream when no verified identity exists; never infer an identity from failed-login email/token |
| Workspace member insert/role/status/delete and invitation create/accept/revoke/delete | workspace transaction triggers | workspace ID; server-bound initiating user, or explicit system for direct/background DML |
| Issue/workspace/credential/Factory/audit authorization refusals | trusted service/HTTP boundaries | verified caller personal stream; known audit member refusal also binds to that workspace; unknown guessed tenant never receives caller data |
| Agent run transitions | source transaction trigger | dispatch captures authorized workspace for a workspace-scoped issue; private issue stays personal; stable mapping/retry inheritance; system actor for automated transitions |
| Worker claim and completion | claim transaction audit and completion transaction actor context | verified worker credential record ID, run ID and server-generated request ID |
| Factory approvals/revocations, attempts and publications | source transaction triggers | actual approval owner; automated transitions explicitly system; authorized Factory transaction supplies workspace scope |
| Account action approval/decline | `pending_actions` lifecycle trigger | personal owner for human decision; system for automatic transitions; operation ID |
| Credential request state/revocation, BYOS connection lifecycle, operation execution/uncertain | source transaction triggers | explicit stored tenant; authenticated creation owner or system lifecycle actor; references only |
| Export, retention policy and pruning | audit service transaction | verified browser owner/workspace admin |

Existing historical rows are not backfilled as if their actors were known. Legacy child deletion with an already-removed parent uses a captured scope where available, otherwise an explicitly non-tenant `system:legacy` stream. These private/system streams are not exposed to arbitrary workspace admins. Existing group/Factory/credential authorization is preserved; this change does not claim every possible application endpoint has an audit event. Team membership and additional future authorization surfaces require the same explicit source integration before any wider coverage claim.

## API contract (existing `/mikka` base path)

Browser sessions only, with cookie cache disabled. Bearer/OAuth/worker credentials cannot query, export or administer audit. Personal requests omit `workspaceId` and are bound to the current authenticated user; workspace requests require a current active **admin** on every request/page, with the membership row share-locked during the read. Member, suspended, removed and foreign users are refused. Mutation requests require the exact origin. JSON policy bodies are limited to 4 KiB. All responses are private/no-store.

- `GET /api/audit?workspaceId=<uuid>&source=application|workspace&after=0&limit=200`: sequence query. `action` and `outcome` are optional exact filters. Max page size 1000. An expired cursor returns 410; queries are not a substitute for integrity verification.
- `POST /api/audit/export?workspaceId=<uuid>` with `Idempotency-Key: <uuid>`: records export and creates per-store immutable boundaries, count and start/end hashes. Retrying the same ID resumes a partially committed two-store creation without creating another export event. Expiry is one hour; expired snapshots return 410 rather than silently refreshing their boundaries.
- `GET /api/audit/export?workspaceId=<uuid>&id=<uuid>&source=<source>&after=<lower_seq>&limit=200`: JSONL manifest followed by canonical events. Start at each source's returned `lower_seq`, save `next`, resume with it, and stop only at `next=null`. Verify every event hash/sequence across pages, `pageDigest`, final `end_hash`, and total `count`. Concurrent new events are excluded from that snapshot. The owner/admin check is repeated even for an existing export ID. A snapshot is bound to its creating actor and tenant.
- `POST /api/audit?...` JSON `{ "operation":"verify" }`: verifies retained chain with bounded-memory paging; a 15-second verification deadline returns an explicit failure, never partial success. Large installations may require an approved offline verification/archival operational window.
- `POST /api/audit?...` JSON `{ "operation":"policy", "retentionDays":90, "legalHold":true }`: per-store/tenant policy; allowed range 1–3650 days. 90 days is a configurable engineering default, not a legal recommendation.
- `POST /api/audit?...` JSON `{ "operation":"prune" }`: deletes only the expired contiguous prefix, atomically records its checkpoint and a new pruning event. Legal hold blocks pruning. Live snapshots pin their covered prefix. Non-monotonic timestamps that prevent safe prefix expiry produce an explicit conflict. No automated deletion schedule is activated by this PR.

System/personal operations may also use `node --import tsx scripts/audit/maintenance.ts <tenant> verify|prune MIKKA_DATABASE_URL|DATABASE_URL` under the existing authorized operator connection. No scheduler/credential is provisioned. Never execute production pruning without the separately approved target and policy. Hash-only event-key tombstones and resource-scope references remain for dedupe/ownership after event expiry; they do not contain secret values or event bodies. Their metadata deletion is a separate data-governance decision, not silently claimed as full erasure.

## Validation and evidence

Run types/lint/source tests/build before actual compiled-server acceptance. `pnpm test:audit` defaults to a DB skip unless the explicit isolated test URLs are supplied; required CI sets `REQUIRE_AUDIT_DB=1` and distinct loopback `_e2e` databases. The dedicated PostgreSQL workflow applies all migrations, repeats the runner and tests the permission matrix, source lifecycle metadata, retry/concurrency, restart via fresh connection, gap-free snapshot paging, holds/pruning, write failure rollback, and controlled owner-override tamper cases. Synthetic history is retained in the cloud workspace where practical. The test runner's exit code is authoritative; fixture-context output is not a passed assertion.

`scripts/audit/http-acceptance.mjs` requires an exact SHA, loopback compiled Next endpoint, distinct loopback `_e2e` databases and synthetic accounts. It records safe request metadata, database assertions, exported pages, raw Chromium video and screenshots of actual audit API responses; never an invented UI. It does not record auth response bodies/cookies/passwords. Review hashes and scan for secrets before uploading evidence to the draft PR.

Required handoff evidence: exact SHA/build result, UTC, fixed cloud endpoint, both migration ledgers, synthetic workspace/actor/run/operation/request IDs, commands/exit status, logs and raw video hashes. Keep failures in the evidence history and distinguish fixed reruns. CI and synthetic HTTP acceptance do **not** establish real Google/GitHub/provider/daemon production acceptance. The issue remains open until fixed-version deployed acceptance, all applicable original issue scenarios and independent review pass. No production endpoint/approval packet has been supplied to this lane; production migration/deployment and user/provider acceptance are pending, not denied or attempted.

Engineering reference: OWASP Logging Cheat Sheet, as linked by #210. Controls used here are bounded structured events, data minimization, access restrictions, failure handling and verifiable integrity; the reference is not a certification claim.

Independent review corrections: ordinary `continuesRunId` mailbox continuations inherit the validated parent scope, alongside `retryOf`; forged owner/issue/mailbox/workspace lineage fails. Real PostgreSQL barriers reproduced the 9532817 stop/complete `40P01`; stable coordinator/target mailbox locking removes that cycle without dropping audit writes. See the new required PG regression and actual HTTP continuation driver.

[Exact SQL manifest](migration-manifest.json), [activation/rollback boundary](migration-rollout.md), and [#230/#231 audit sink contract](policy-integration-contract.md) accompany this candidate. Production SQL remains unexecuted.
