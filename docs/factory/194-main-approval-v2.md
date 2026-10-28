# Factory approval and publication consumer contract

This #194 batch extracts the approval/publisher modules from PR229
`8878cd519f25ae64dab3cc90a57b4fbe00fee7d5`, with the non-enterprise
interfaces also present in PR316 `4c1255dbbb81b6247a3b68b7d946d22a6e8030be`.
It is based on main `4f52bbb2161d7016e95b95b5db3e3aa05afb89a2`.
It does not carry PR316's Skill activation, monitor, question recovery or other
Factory stages into main.

## Scope and integration status

Main did not yet contain #192's Factory tables/store/routes or #193's independent
check gates. These modules consequently have **no registered application route,
daemon tool, production migration or enabled adapter** in this batch. Merging
application code cannot issue a Factory human approval or authorize provider writes.
This is a reviewable consumer-library batch, not completion of issue #194 or
evidence that Factory is available in the application.

`approval-dependencies.ts` is a structural port for #192's existing
`createFactoryStore(pool, authorize, gates)` result. It defines no stage ordering,
transition implementation or separate task/candidate tables. `approval-contract.ts`
validates consumer requests using the frozen binding, candidate and artifact
reference shapes; it is not a second persisted source of phase state.
At integration, retain one canonical set of these wire validators/error codes
(the stage contract can re-export the identical schemas), rather than maintaining
divergent copies. HTTP error normalization must use the public `factory*` code
when a store and consumer have different Error class identities.

The integration owner must provide:

| Owner            | Required input                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #192             | Authorized/locked `FactoryTask` with id, userId, issueId, attemptId, candidateId, revision, stage, status; store `apply(userId, binding, eventId, change, tx)` returning the updated task; `FactoryAuthorize` |
| #192             | `factory_tasks`, `factory_candidates`, `factory_attempts`, `factory_events`; transaction-compatible owner/candidate/revision fences                                                                           |
| #193             | Independently passed execute/review/verify attempts, distinct actual run/session identities and readable same-run evidence; install its review/verify gates in the same store                                 |
| #194 integration | Apply the existing approval-ledger DDL **after** #192's tables, using the coordinated migration order; register `approvalGate`, `publishGate` in that same store, then construct `createFactoryApprovals`     |
| Browser adapter  | Verify an actual Better Auth cookie via `factoryBrowserHuman`; pass only the resulting identity to the handler, never identity from JSON or a worker token                                                    |
| #195             | Consume the V2 reader below; keep its monitor/probe implementation in its own PR                                                                                                                              |

The test-only ledger DDL in `tests/fixtures/factory194-ledgers.sql` is copied
from PR316's #194 consumer migration. It is not registered under `drizzle/` and
must not be mistaken for an applied application migration. The matching runtime
schema/route integration remains pending #192/#193; this batch cannot consume
nonexistent upstream evidence as real review or verification.

## Human approval and logical action

`approve` requires the live linked browser session to read the current immutable
evidence manifest first. The persisted grant binds owner/session, full candidate
(exact SHA/repository/execution environment/scope), evidence/read digest,
Factory attempt/revision/candidate fence, action, destination and expiry.
Expiry is checked against database time with a maximum lifetime of 24 hours.
Failed provenance, revocation, replacement candidates and stale fences remain closed.

Actions are `deploy_preview`, `deploy_production`, `merge`. Candidate push and
repository merge authorization do not create an application grant. The deployment
environment is separately approved as `targetEnvironment`; the candidate's
`environment` remains execution provenance such as `device:<UUID>`.

The publication ledger reserves one operation before any effect. Its uniqueness
fences forbid a second logical action even with a fresh approval. The task lock
and human/evidence checks are repeated immediately before the registered adapter's
POST. Pending operations retain a trusted checkpoint; unknown outcomes remain
uncertain. `reconcile` accepts only the original publication request plus the
publication ID, and performs provider reads only. A client success receipt or
checkpoint is never accepted. Database rollback after an external effect does not
permit another POST. Replay of a stored success still checks current grant/fence.

Preflight failures conservatively retain the reservation. This batch has no
automatic reset/rearm operation; absence of a matching remote operation is not
permission to create one again.

## Vercel adapter

Only the existing Mikka team/project/repository is configured:
`team_C7lwxVVvnUicFli6112mvxpv`, `prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH`,
`https://github.com/alexj11324/Mikka.git` / repo ID `1427517699`.

| Action              | Qualified target suffix / targetEnvironment | Receipt kind            |
| ------------------- | ------------------------------------------- | ----------------------- |
| `deploy_preview`    | `:preview` / `preview`                      | `preview-deployment`    |
| `deploy_production` | `:production` / `production`                | `production-deployment` |

The complete target is `vercel:<teamId>:<projectId>:<environment>`. Runtime flags
separately register Preview (`FACTORY_VERCEL_PUBLICATION=1`) and Production
(additionally `FACTORY_VERCEL_PRODUCTION=1`) only when explicitly called by the
trusted integration. The existing secret-managed `VERCEL_TOKEN` binding is
required; no CLI account file is read and no token is created or copied.

POST `/v13/deployments` uses exact SHA in both Git source `ref` and `sha`.
Preview omits `target`; Production sets `production` and can assign existing
production aliases. No project/build overrides, new resources, domain changes,
promotion or forced rebuild are sent. The code does not promise Vercel request
idempotency: once-only creation is enforced by the durable Factory reservation.

Readback must confirm the fixed project/account, provider GitHub source SHA and
repository, destination, operation metadata and unique HTTPS deployment URL.
Metadata alone cannot establish code identity. READY is required; production also
requires alias assignment. A known deployment ID is read directly. A lost create
response uses complete bounded list pagination and exactly one UUID/hash match.
Reconciliation never creates or promotes a deployment.

## #195 V2 reader

`readFactoryPublicationReceiptV2(tx, userId, taskId, candidateId)` must be called
inside #192's authorized, locked transaction. It returns `FactoryPublicationReceiptV2`
or fails closed:

```ts
{
  version: 2,
  publicationId, approvalId, taskId, issueId, candidateId,
  candidate: { sha, repository, environment, scope },
  action, target, targetEnvironment, publishedAt, reference,
  verifiedTarget: {
    kind, operationId, target, environment, repository, sha, reference, observedAt,
    provider?: {
      version: 2, name: "vercel", teamId, projectId, deploymentId,
      environment, publicationId, bindingHash
    }
  }
}
```

The reader checks succeeded publication, exact passed publish attempt/output,
grant/ledger/request/candidate consistency, the original publish fence and receipt
timing. Provider bindingHash covers publication ID, full candidate, owner,
approving session, approval ID/expiry, original publish fence/event/action/target.
Expiry after a legitimate consumption does not erase history; revocation,
cancelled tasks and changed candidates block consumption. The legacy V1 reader
rejects production. Local artifacts and merge receipts cannot establish cloud health.

#195 must explicitly bind probes to deployment ID, exact SHA/environment/reference,
and prove that the current production domain/aliases route to that deployment.
Provider READY is not application health or real-user acceptance. This PR does not
change #195's validator or claim its implementation already consumes V2.

## Evidence and next real execution

Tests use actual loopback HTTP and disposable PG17 with synthetic upstream
run/session reports, a test-only #192 store port and synthetic browser identity.
They establish approval/receipt/transaction behavior, not real Harness, OAuth or
Vercel deployment acceptance. They are enrolled in the existing unit and ephemeral
DB CI gates without relaxing required checks.

Issue #194 remains open until #192/#193 integration, actual human evidence read
and approval, exact-candidate deployment on a specifically approved controlled
target, #195 observations and applicable user flow/video acceptance are complete.
The next provider write requires exact action/target/environment/SHA approval;
general application deployment or repository merge approval is insufficient.
The minimal real write scope is the existing project's one deployment POST,
followed by GET/list reconciliation. No new credential, IAM, resource purchase or
production migration is included in this code batch.
