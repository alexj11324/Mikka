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

No pre-existing Factory deploy credential issuer/verifier was found in these
call paths. This batch now implements a concrete run-bound verifier and worker
backend composition, described below; it configures no live issuer or trust key. #161's reported local implementation has not been delivered or
consumed here; it must not be described as a working generic credential service.
No production signing key, identity, credential or permission action is created by this batch. Synthetic keys are generated only in isolated tests.

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

## Concrete worker backend and run verifier

`factoryPublicationForWorker(request, deps)` in `worker-publication.ts` is the
backend call point. It uses the actual existing `verifyRunToken`/`workerRun`, then
derives owner/run/Bot/token hash on the server. No model JSON chooses that identity.
It wraps the existing issue authorizer with a current token/run/device/STOP/lease
check under the same task transaction, including evidence and ledger reads.
It registers no HTTP route or worker tool and expands no frozen tool grants.

`createFactoryPublicationHost(pool, authorize, createStore, host, adapters)` composes
one canonical #192 store, configured gates and the publication service. The
`createStore(gates)` callback must retain #193 and all other owners' lifecycle
gates; it is not a second store or orchestrator. Its concrete
`createFactoryRunDecisionAuthority` verifies data on existing application tables:

1. Lock the authorized current task through #192, preserving Bot/source/issue
   access, candidate and current grant/publish fences.
2. Recheck the authenticated existing run token, owned enabled device, run owner,
   issue, STOP, lease, session and frozen assignment. Acceptance runs remain
   mechanically read-only regardless of a policy callback's answer.
3. Read the signed nonce from the existing run's event stream. The current
   `runEventBatchSchema` already accepts the exact chunk shape below; the existing
   events route assigns the row UUID and deduplicates `(runId, seq)`. The signed
   nonce is independent of that server-generated UUID. Exact repeated chunks do
   not create another grant/effect.
4. Verify Ed25519 using only the host's trusted public-key lookup, domain-separated
   payload plus issuer/keyId, current assignment/session and full publication scope.
   This module has no signer, private-key loader or credential-issuance endpoint.
5. Consume #192's committed review/verify `finish:passed` event snapshots, matching
   the current latest attempts, run/session, candidate, owner/Bot/source, revisions,
   output and evidence. It does not fabricate running projections to call #193's
   running-only predicate. The producer must actually install #193 and the stage owner's real semantic
   validators before writing these server-owned receipts. Its independence
   result alone is not semantic pass; test callbacks cannot substitute at runtime.
6. Read/lock the actual current explicitly registered publication policy. The host
   resolver must return `id/revision/ownerId/runId/assignmentDigest/scopeDigest`,
   explicit `permissionAction`, `readOnly` and `decision`. Both its version and full
   scope digest must match the signed review. A connection version, desktop/network
   permission or unknown-action ask fallback is insufficient. Missing source rejects.
7. Only a registered ask reads the existing exact live confirmation. Grant
   revocation, token/key/policy changes and current fences are checked again at
   the final effect boundary. A failed reservation never becomes another POST.

The stream shape is `{type:"data-factory-publication-review", data:{issuer,keyId,
payload,signature}}`. The payload is `factoryRunReview`: signed nonce, owner,
executor run/session, assignment digest, policy id/revision, explicit chosen action,
full scope digest, issued/expiry times, the two canonical check receipt references
and host-attested model judgment/input provenance. It contains no allow/ask/deny
permission. Current policy supplies that decision. Signatures include the
issuer/keyId as well as payload; the key lookup never comes from model JSON.

Verified evidence persists the actual server chunk row ID, signature digest and
run/session/assignment/check-receipt/review/key-fingerprint bindings in the existing
grant. It stores no private key or raw token. V2 hashes bind this evidence.

The concrete verifier is executable with injected trusted sources. Main still
has no registered Factory publication policy-version source or authenticated
attestation producer/public-key binding for this purpose. Production must not
substitute the test resolver or synthetic signature material. Source tests use an
authentication transport substitute; isolated PG tests exercise actual token/run/
lease/device/check-event SQL, real Ed25519 and a disposable local artifact.
The joint fixture consumes actual #192 source `60e6b2...` and actual #193 v2
predicate for committed check passes; semantic validators, model invocation and
current policy data remain explicitly synthetic. No real deployment authorization
is signed and no real provider is called.

### Actual shared model receipt consumer

The shared #193 source `7760bcb7556ae918948aba58a377e4359b91ea5c`
exports `invokeDecision()` and its host-produced `DecisionExecution` in
`lib/coordinator/decide.ts`. This batch's `decision-execution.ts` consumes that
actual structural result: `factoryPublicationJudgment(result, expected)` takes
the returned answer Map and host execution receipt. It returns semantic evidence
only when the model chooses `publication=publish_current`; missing, refusal and
`defer` produce no judgment. Confidence is not another program threshold or
confirmation. The normalizer defines no caller, signer or permission issuer.

The concrete signed run review now requires `choice`, `requestDigest` and
`execution` in its judgment. Execution fields are `executionId`, `modelId`,
`providerGenerationId`, `startedAt`, `completedAt`, `requestDigest`, ordered
`imageDigests` and `vision` (`image-input-submitted` or `no-image-input`). The host
supplies its actual selected `decisionModelId`; the verifier compares model,
receipt identity, request digest, ordered pixel digests, visual-input requirement
and times between executor start and signed review issuance (which must precede
server event observation). These are
provenance/integrity checks, not program evaluation of the scene. Submitted images
do not establish visual understanding or permission. A claimed execution nested
inside a model answer cannot replace the actual host receipt.

Compile-time consumption was checked against the actual shared frozen source,
without loading/calling its transport. Isolated tests use structural synthetic
receipts and explicitly do not prove a real model run. The trusted producer must
call the actual shared transport with real required images, derive expectations
from its actual request, then attest that result. No live producer/key/policy
source is configured here; a model-supplied receipt or `allow` is insufficient.

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
they do not fall back to human approval. The upstream bare-gate runtime therefore still needs this explicit host
integration with real registered policy and attestation sources.

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

## Test resource retention

The #194 fixture teardown retains database schemas and rows, artifact directories
and protocol audit JSON by default. It has no schema/record/directory/container
deletion option. Fault injection invalidates a synthetic check without deleting
its event. Its scoped rollback trigger and function remain installed in the
isolated schema. HTTP substitutes persist request/deployment audit data and
unref their listener rather than destroy connections. PostgreSQL client shutdown
does not remove the database or container. These changes do not retroactively
authorize or establish retention for earlier runs.

Shared CI startup/teardown scripts outside #194 still include destructive paths
(including migration-fixture schema drops and Docker `--rm`/`rm -f`). They must be
coordinated with their owners before a new ref update automatically runs those
jobs. Do not treat the older head's CI as acceptance of this source or launch a
build/test cleanup path merely because the Factory feature is disabled.
