# Vercel publication receipt V2

This adds a publisher implementation to the frozen Factory stage contract. It
does not change stages, create another orchestrator, rename migrations or change
review/verify/monitor validators. Existing publication JSON stores the checkpoint.

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

## Runtime enablement and acceptance boundary

`FACTORY_VERCEL_PUBLICATION=1` registers the Preview adapter; additionally
`FACTORY_VERCEL_PRODUCTION=1` registers Production. Registration requires the
existing secret-managed `VERCEL_TOKEN` runtime binding. No account file is read,
token created or env file written. The connected inspection app is not implicitly
a runtime credential. Missing delivery fails closed and needs the existing cloud
secret delivery owner; this code does not create new credentials or access.

The deployment API and configured project were inspected read-only. Local tests
exercise actual HTTP, PG17, reservation/reconnect, queued-to-ready, accepted POST
with lost response, SQL rollback, identity mismatches and revoked/expired/stale
grants. Their provider is an explicitly named loopback protocol substitute, not
a cloud deployment. These tests do not establish real Harness evidence, human
OAuth acceptance, production health or a user's end-to-end workflow.

The next real execution scope is one human-approved exact candidate, action and
destination on the fixed existing project: project GET, one deployment POST and
GET/list reconciliation, followed by #195 probe and real user acceptance/video.
No credential creation, IAM, project/domain mutation, paid resource purchase or
frontend change is included. A production action includes assignment of the
project's existing production aliases. This implementation itself executes none
of those provider writes.

API references: [create deployment](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment),
[get deployment](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url),
[list deployments](https://vercel.com/docs/rest-api/deployments/list-deployments).
