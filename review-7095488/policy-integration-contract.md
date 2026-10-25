# Audit sink contract for #230 / #231

This contract describes the current #259 writer, not a new policy control plane. It requires the integrated #257 schema plus #210's two exact migrations. A policy lane based only on main must not activate live enforcement while this sink is absent, or replace the sink with a successful no-op.

## Source transaction and identity

Import `appendAudit` from `lib/audit/store`. Signature:

```ts
appendAudit(client: Pick<PoolClient, 'query'>, tenant: string,
  event: AuditEvent, eventId?: string): Promise<void>
```

Use the **same held PostgreSQL client/transaction** that persists the policy version or admission decision. Pass a verified workspace UUID, or server-derived `personal:<userId>` for an actually personal operation. Never obtain tenant/actor/credential identity from model output or an unverified request field. The database containing the policy/decision row must have the audit core installed: application -> `MIKKA_DATABASE_URL`; workspace -> `DATABASE_URL`. These are independent stores/snapshots unless their persistent `storeId` is the same. This API does not provide distributed commit.

The event shape is an exact allowlist:

```ts
type AuditEvent = {
  actorId: string; actorType: 'human' | 'worker' | 'system' | 'anonymous';
  subjectId?: string; resourceId: string; action: string;
  outcome: 'success' | 'denied' | 'failed' | 'uncertain' | 'pending';
  reason: string; requestId?: string; runId?: string; operationId?: string;
}
```

Every value is a nonempty bounded reference/code (`^[a-zA-Z0-9_:.@-]+$`, max 200 characters); tenant max 240. IDs are non-secret record IDs, never a bearer, prompt, email, raw URL, provider response or source exception. The stable `eventId` is a UUID per logical event/stage: exact replay has one event; same UUID with changed data fails `security_audit_id_conflict`. Pending/admitted/result/revoked stages need distinct durable IDs, while keeping the same operation/decision ID. Without an ID the helper generates one, so callers requiring retry dedupe must supply their persisted ID.

Examples, after current authorization has succeeded:

```ts
await appendAudit(tx, verifiedWorkspaceId, {
  actorId: verifiedHumanId, actorType: 'human',
  resourceId: immutablePolicyVersionId, action: 'policy.published',
  outcome: 'success', reason: 'explicit_admin_publish',
  requestId: serverRequestId, operationId: changeOperationId,
}, persistedPublishAuditId)

await appendAudit(tx, verifiedWorkspaceId, {
  actorId: workerCredentialRecordId, actorType: 'worker',
  subjectId: verifiedOwnerId, resourceId: immutableDecisionReceiptId,
  action: 'model.admission', outcome: 'denied', reason: 'endpoint_not_allowed',
  requestId: serverRequestId, runId, operationId: invocationOperationId,
}, persistedDecisionAuditId)
```

If identity or tenant is unknown, do not write an attacker-guessed victim tenant: use the verified caller's personal stream, or `system:auth` with `anonymous` and fixed safe codes. A refusal audited separately from its rolled-back business transaction needs a deliberate durable refusal transaction; do not insert it into a transaction that will immediately roll back. Errors remain errors: propagate audit failure, map to a fixed unavailable response and prevent the protected external call. Do not swallow it, silently fallback or schedule a best-effort write.

## Policy/provider/version metadata boundary

Current v1 does **not** accept extra `policyHash`, `policyVersion`, `provider`, `model`, `endpoint`, `region` or `parentRunId` keys. Unknown keys are rejected at the DB, not silently stripped. Do not encode arbitrary JSON into `reason`, or squeeze a URL/model alias into a reference field.

For the current contract, `resourceId` points to an immutable, tenant-authorized policy/decision receipt owned by #230/#231. That receipt must bind the effective policy hash/version, normalized provider/model and deployment-controlled endpoint/region IDs, selected fallback/child lineage, budget reservation and signed capability proof as applicable, without secret material. Audit events retain its stable ID plus run/operation correlation; authorized policy readers resolve the receipt. The current audit JSONL alone does not inline those policy/provider fields, so this reference design must not be described as an inline provider/region audit record.

If #231 requires these fields directly in JSONL, coordinate a small versioned structured-field extension to both the TypeScript type and both DB validation functions, with safe normalized IDs and migration/regression checks. That extension is **not** already implemented by #259; do not make producers emit unsupported fields. Policy owner and coordinator should choose one receipt schema before live integration.

## Before side effects, fallback and rollback

Resolve/validate current policy and worker capabilities, reserve budget, persist the immutable admission receipt, append the pending/admission audit, then commit **before** invoking an external model. Recheck and record every fallback/child/retry/resume under its actual current effective policy. A changed policy is a new decision, not a replay under the old event ID. Rollbacks are new monotonic policy versions and new audit events; never rewrite old audit events/scopes.

An external provider effect and a database commit are not atomic. After a lost response or audit failure following an effect, use the existing #208 operation identity/uncertain/reconciliation contract; do not resend a potentially completed action. #210 does not implement budget settlement or provider reconciliation on behalf of the policy lane.

## Readers

`GET /mikka/api/audit` and JSONL export require a current browser session and active workspace admin (or the current personal owner). Worker/OAuth bearer credentials cannot query/export/administer audit, even if the request also has a valid cookie. Policy distribution to daemon/child must use the policy lane's separate authorization endpoint; do not broaden audit export permissions for it. See the parent acceptance README for exact query/export/policy/retention HTTP contracts, snapshots, codes and integrity limits.
