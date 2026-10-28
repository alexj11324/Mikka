# Factory authorization and publication consumer contract

This #194 batch extracts non-enterprise publication consumers from closed PR229
and PR316, then removes the unconditional human-approval requirement. It does not
register an application route, migration, issuer, model or enabled adapter.
Factory functional acceptance is incomplete; no merge or deployment is approved
by CI success, unregistered code or this document.

## Existing authority inspected

`packages/protocol/src/agent-policy.ts` defines the existing allow/ask/deny policy;
`packages/daemon/src/permissions.ts` enforces it for registered actions. Its actual
registry includes git/network permissions, not a generic Factory deployment
credential. `lib/computer/reviews.ts` authenticates exact computer-operation
reviews, and `lib/cua/local-review.ts` validates their digest. These are not
Factory deploy signatures. `lib/coordinator/decide.ts` is a model-answer transport,
not an execution-permission issuer; its text response cannot grant authority.

No current Factory deploy credential issuer/verifier was found in these actual
call paths. #161's reported local implementation has not been delivered or
consumed here; it must not be described as a working generic credential service.
No signing key, identity, credential or permission action is created by this batch.

## Policy and semantic decision seam

`policy-authorization.ts` exports:

```ts
interface FactoryDecisionAuthority {
  verify(
    tx: PoolClient,
    credentialId: string,
    expected: FactoryDecisionScope,
  ): Promise<unknown>;
}
authorizeFactoryDecision(tx, authority, credentialId, expected);
createFactoryApprovalGates(authority); // exported by approval.ts
```

The host must implement `verify` through its real existing policy/review authority,
including signature/provenance, immutable credential identity, the registered
publication action, current policy revision and revocation. It resolves actual
owner/workspace/run assignment, STOP and lease fences where applicable; these
cannot come from a model's JSON. An unknown action's `ask` or `network=allow` is
not a Factory deployment permission. Missing authority returns
`factoryPolicyDecisionUnavailable`, with no automatic human-confirmation fallback.

The expected scope binds owner, complete task/attempt/revision/candidate fence,
exact candidate SHA/repository/execution environment/scope, explicit publication
action, destination/environment, evidence digest, visual-input digests and expiry.
`FactoryVerifiedPolicyDecision` carries the credential/issuer/policy revision,
registered action, scope digest, issued/expiry times, signature-verification
receipt/digest and the host-recorded model invocation provenance.

Business interpretation and operation selection belong to a vision-capable
model. The host records its actual model identity/capability, input evidence digest
and actual image-input digests; a model asserting it saw an image or is allowed
is insufficient. A visual task without the required image inputs fails closed.
These consumers do not classify login success, infer it from password visibility,
or choose an action through deterministic business rules. Program checks retain
identity, permissions, signatures, binding, expiry, revocation and data integrity.
The current artifact transport reads owned run reports/chunks; it cannot supply
real screenshot/video bytes yet. Actual visual provenance remains a dependency.

`allow` advances without a human/session prerequisite. Only an existing policy
`ask` needs a verified confirmation bound to that exact credential, owner, scope
and expiry. The existing authority supplies and verifies that confirmation; this
consumer does not create a second question/approval flow. `deny` stops. Browser
HTTP still authenticates its real cookie/session and same origin; that is
transport identity, not a blanket human decision. Backend calls require a trusted
authenticated owner and the same policy proof; JSON never chooses the actor.

The grant remains in the existing approval ledger. New grants require
`decisionCredentialId`, frozen scope and verified decision evidence. A unique
issuer/credential index permits one grant; event replay returns that grant.
Candidate/action/target publication uniqueness reserves one logical effect before
POST. The authority is rechecked at grant, gate, pre-POST and reconciliation
boundaries; a stale allow is not cached. Revocation during provider preflight
prevents POST. Pending/uncertain or post-effect SQL failure permits only GET/list
reconciliation, never another creation attempt. Preflight failure retains the
reservation; no automatic reset/rearm operation exists.

## #192 integration

The intake-only `283a64232fe444505a59fed15d8364214512f26a` lacks lifecycle
finish/advance and cannot supply the port. Actual lifecycle source
`60e6b2a9834bedaaa68b60a03b3807ca640c602c` exposes:

```ts
createFactoryStore(pool, authorize, botId = null, lifecycle?)
store.lockTask(tx, userId, taskId)
store.apply(userId, binding, eventId, change, existingTx?)
```

Third argument is Bot identity, fourth is `{gates?, independent?}`. Install
`createFactoryApprovalGates(realAuthority)` as approval/publish gates, and pass the
same authority as the fifth argument of
`createFactoryApprovals(pool, authorize, store, adapters, authority)`. Bare exported
`approvalGate`/`publishGate` have no configured authority and reject new grants;
they do not fall back to human approval. The current upstream runtime's bare-gate
installation therefore still needs this explicit host integration.

All consumer reads/grants/publication/reconciliation use producer `lockTask`,
retaining task/issue lock ordering, live owner/Bot/source access and current fences.
`apply` joins the same transaction. No duplicate stage source is introduced.
Approval/publish do not dispatch model runs and are outside #192's
review/verify/monitor run-consumer map. Publication reconciliation is the existing
service's `reconcile(actor, {...originalPublicationRequest, publicationId})`;
it consumes the same policy proof and only reads the provider.

Actual isolated consumption of `60e6b2...` passes locked-source denial, configured
approval/publish gates, atomic advance, once-only publication replay and V2 reader
consumption. The older `b383921...` completion timestamp defect is fixed in that
new source and is no longer the current blocker. This uses synthetic upstream
reports/identity/policy/model records and loopback HTTP, not a real policy issuer,
Harness, OAuth flow, vision-model invocation or cloud deployment.

`tests/fixtures/factory194-ledgers.sql` is isolated test DDL, not a registered
Drizzle migration. Its updated principal/decision fields and unique credential
index need an explicitly coordinated application schema manifest before runtime
use. No production SQL or flag has been executed or enabled here.

## Vercel and #195 V2 receipt

Only the existing Mikka team/project/repository is configured:
`team_C7lwxVVvnUicFli6112mvxpv`, `prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH`,
`https://github.com/alexj11324/Mikka.git` / repo ID `1427517699`.
The target is `vercel:<teamId>:<projectId>:<preview|production>`.
`deploy_preview` yields `preview-deployment`; `deploy_production` requires
`production-deployment`. Execution provenance remains the candidate's separate
environment. Registration flags and existing secret binding are not enabled here.

One POST uses the exact Git SHA. Readback checks actual Git source, project/team,
environment, operation metadata, immutable deployment URL and READY; production
also needs alias assignment. Metadata alone cannot prove code identity. Lost
responses use complete bounded GET/list inspection. No promotion, domain change,
new resource or credential creation is included.

`readFactoryPublicationReceiptV2(tx, userId, taskId, candidateId)` requires the
producer's authorized task lock and returns the same V2 envelope:

```ts
{
  version: 2, publicationId, approvalId, taskId, issueId, candidateId,
  candidate: { sha, repository, environment, scope },
  action, target, targetEnvironment, publishedAt, reference,
  verifiedTarget: {
    kind, operationId, target, environment, repository, sha, reference, observedAt,
    provider?: { version: 2, name: "vercel", teamId, projectId, deploymentId,
                 environment, publicationId, bindingHash }
  }
}
```

The discriminator is `verifiedTarget.kind`. New provider binding hashes cover the
frozen policy decision's credential/issuer/revision/scope/full-evidence digest in
addition to publication ID, full candidate, owner, grant, original publish fence,
event, action, destination and expiry. They no longer require a human session.
Historical human-bound V2 receipts remain read-compatible; no new human-only
grant is issued. The reader checks recorded policy/model/ask proof consistency,
exact passed publication and timing. Missing/reserved/uncertain, revoked/stopped,
replacement candidate or substituted scope fails closed. Expiry after legitimate
consumption does not erase history. The legacy V1 reader rejects production.

#195 keeps its own probes. It must prove deployment ID, exact SHA/environment,
reference and actual production-domain routing. Provider READY is not user-flow
health. No real-user acceptance video is claimed until that chain is exercised on
an authorized real target with real evidence.
