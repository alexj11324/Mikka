# Vercel publication receipt V2

Factory code candidates are accepted through the person's GitHub merge (#528). The production approval service registers Skill activation. Historical Vercel publication receipts remain readable, and the configured V2 monitor verifies them with GET requests. The old write protocol is exercised only by a loopback test fixture.

This document records the historical publication format and its authorization conditions.

## Destination and authorization

The runtime adapter is restricted to the existing `mikka` project
`prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH`, team
`team_C7lwxVVvnUicFli6112mvxpv`, GitHub repository
`https://github.com/alexj11324/Mikka.git` (repository ID `1427517699`).
Runtime project readback must also confirm the GitHub link before any POST.

| Field                       | Preview                               | Production                               |
| --------------------------- | ------------------------------------- | ---------------------------------------- |
| approval/publication action | `deploy_preview`                      | `deploy_production`                      |
| target                      | `vercel:<teamId>:<projectId>:preview` | `vercel:<teamId>:<projectId>:production` |
| targetEnvironment           | `preview`                             | `production`                             |
| POST target                 | omitted                               | `production`                             |
| receipt kind                | `preview-deployment`                  | `production-deployment`                  |

`candidate.environment` remains the Harness execution provenance, such as
`device:<id>`. It is never substituted for the destination environment.

The existing cookie-authenticated human route issues and consumes approvals.
Every call checks owner, live linked human session, exact candidate, complete
Factory fence, evidence digest/read receipt, action, target and expiry. The
publisher receives this trusted context from SQL, never from a client-supplied
identity or callback. The binding hash covers publication ID, candidate, owner,
approving session, approval ID/expiry, publish fence, event, action and destination.
Only the opaque publication UUID and hash are sent as Vercel metadata. Metadata
alone is not a success receipt.

## Provider operation and recovery

`POST /v13/deployments?teamId=...` uses the existing project settings and GitHub
`gitSource` with both `ref` and `sha` pinned to the exact approved 40-character
SHA. It supplies no files, build overrides, forced rebuild, credentials, domain
configuration or promotion command. Production creation can assign the existing
project production aliases; this is part of the production action's scope.

The durable reservation allows one create request. Vercel's create endpoint does
not document an idempotency guarantee. A timeout or a crash never authorizes a
second POST. The ledger stays `reserved` for a pending operation or `uncertain`
for an unknown outcome. Neither passes the Factory publish stage.
Preflight failures conservatively retain that reservation even when this process
knows it has not sent POST. This version has no automatic reset/rearm operation.

The same browser route accepts `operation: "reconcile"`, with the original strict
publication request plus `publicationId`. It accepts no receipt/checkpoint.
The owner can recover the original request from the authorized ledger view.
HTTP 202 means pending; HTTP 409 means uncertain. Both deferred responses carry
the publication ID and `nextOperation: "reconcile"`.

Reconciliation rechecks the same approval/fence and performs only provider reads:

1. Read the fixed project and verify its account and GitHub repository link.
2. Read the checkpoint's exact deployment ID. If the create response was lost,
   list project deployments filtered by SHA and match both publication UUID and
   binding hash. Exactly one match across complete bounded pagination is required.
3. GET the exact deployment, verifying project, team, Git SHA, environment,
   metadata and unique deployment URL. Conflicts, missing/ambiguous operations or
   incomplete pagination remain closed. No result is a permission to recreate.
4. Require `READY`; production also requires successful alias assignment. Then
   persist the provider receipt and finish the existing publish stage in one SQL
   transaction. A SQL rollback after the external effect is recovered by readback.

Revoked/expired grants, signed-out humans, replaced candidates, stale revisions
and stopped tasks cannot complete reconciliation. Such an external effect may
still exist; intervention must inspect it rather than minting a success receipt.

## Receipt and monitor handoff

`readFactoryPublicationReceiptV2(tx, ownerId, taskId, candidateId)` returns the
existing envelope with `version: 2`, the exact action/target/targetEnvironment,
candidate and publication/approval IDs. It requires a succeeded ledger entry,
passed publish attempt and consistent current candidate/approval provenance.
The caller must first authorize and lock the Factory transaction.

`verifiedTarget` retains operationId, repository, SHA, reference and observedAt,
and adds this provider identity:

```ts
provider: {
  version: 2,
  name: "vercel",
  teamId, projectId,
  deploymentId,       // equals operationId
  environment,       // exact preview or production, equals targetEnvironment
  publicationId,     // equals envelope publicationId
  bindingHash,       // SHA-256 of the complete trusted operation context
}
```

`reference` is the immutable HTTPS `*.vercel.app` deployment URL. Moving Git
aliases and shared production domains cannot identify the candidate. A provider
READY receipt proves deployment identity, not application health or user acceptance.
#195 must explicitly adopt V2 and add a production probe tied to this deployment,
SHA and environment; the legacy V1 reader rejects production. Preview or local
artifact observations cannot satisfy a production check. This change deliberately
does not modify #195's validator.
For real-user production acceptance, #195 must additionally establish that the
current production domain/alias routes to this deployment; probing only its
immutable deployment URL does not establish the shared production domain's state.

## Historical protocol verification

The loopback HTTP fixture in `tests/helpers/factory-vercel-publication.ts` exercises the old receipt format, reservation and recovery against disposable test data. It accepts an explicit loopback origin. The application uses the deployment switches and its existing credential for historical read-only observation as documented in [Factory monitor V2](195-vercel-monitor-v2.md). The application’s current build, promotion and rollback owners are documented in the [build source of truth](../operations/build-source-of-truth.md).

API references: [create deployment](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment),
[get deployment](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url),
[list deployments](https://vercel.com/docs/rest-api/deployments/list-deployments).
