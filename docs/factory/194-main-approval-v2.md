# Factory authorization and publication consumer contract

> Update 2026-10-29: the mandatory signed review and trusted `reviewKey` below
> are now the optional strict deployment. Mikka's default follows the Warp
> Factories model: advisory review, registered policy as the authority, no
> application merge. See `warp-aligned-factory.md` for the current behavior;
> this page remains the record of the #194 batch.

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

An approval has two sources. The default, Warp-aligned path is a person
approving in the browser: `approve` re-checks the live session and its linked
GitHub or Google account inside the task transaction, records the approval with
`humanSessionId` and no policy fields, and `validApproval` re-checks the live
session at the gate, pre-POST and reconciliation boundaries. No decision
authority or credential is involved, and no model may approve its own work
because the route accepts only a real browser session, never a worker token.

A deployment that installs a policy authority may instead send
`decisionCredentialId`. `allow` advances; only an existing policy `ask` needs a
verified confirmation bound to that exact credential, owner, scope and expiry;
`deny` stops. Backend calls without a session still require that policy proof.
Browser HTTP always requires the real cookie/session and same origin, and JSON
never chooses the actor.

The grant remains in the existing approval ledger. Human grants store
`humanSessionId` with null `decisionCredentialId`, `decisionScope` and
`decisionEvidence`; policy grants require all three. A unique
issuer/credential index permits one policy grant; event replay returns that
grant.
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

### Canonical preparation, invocation and issuer

`createFactoryRunReviewIssuer(store, host, signer)` exports `prepare(tx, scope)`
and `issue(tx, scope, invocation)`. Preparation locks the current task/executor,
checks current registered policy and expiry before any model call, reads canonical
issue title/content/revision, originating user event and frozen assignment, then
reads and hashes the existing report/chunk artifacts. Only redacted canonical
content enters observations. No client/model observations are accepted by the
worker composition. Unsupported image artifacts still fail; arbitrary URLs
cannot substitute for stored pixels.

`invokeFactoryPublicationDecision(scope, executor, observations, transport)`
freezes the complete request before calling the injected actual shared serializer
and invoker. Executor includes run/session/assignment, canonical instructions
digest and policy ID/revision. The fixed questions ask the vision-capable model
to choose `text_sufficient|visual_required` and `publish_current|defer`. Missing
answers fail; a visual requirement without actual submitted images fails. The
program does not infer task semantics from absent images or apply confidence
thresholds. Result model/request/image/time provenance must match the original
request; an opaque process-local handle prevents post-call scope rebinding.

Issuance relocks/rechecks canonical state and original invocation, then signs a
server-generated nonce using an injected existing Ed25519 key only when its public
key matches the current trusted identity. The signed payload includes
`instructionsDigest`; the verifier rereads issue/source/assignment requirements
at every grant/gate/pre-publication authority check, so later edits invalidate
stale judgments. Unscoped originating user events follow #192's null-or-matching
issue rule. No key loader, permission registration, endpoint, parallel ledger or
event-sequence writer is added. Returned chunks use the existing run event writer.

`factoryPublicationForWorker` derives owner/run from existing worker transport.
When trusted server dependencies supply `reviewSigner` and `reviewTransport`,
`review(scope)` performs prepare transaction → shared invocation → issue
transaction. It clones the scope before its first await. No model call occurs
inside the database transaction. The returned chunk is not itself persisted or
an execution grant; request JSON cannot install dependencies.

Policy deny/read-only stops before signing-key access. For ask, the signed review
is semantic evidence only: the existing exact confirmation after issuance remains
necessary. No blanket human confirmation or backdated confirmation is introduced.
The isolated issuer/verifier tests use synthetic model/policy/key materials and a
real local artifact. Actual #192/#193 source composition verifies transaction and
ancestry contracts; semantic validators remain synthetic.

Live installation still needs the actual registered publication policy/version
resolver, an existing authorized signing identity/key binding, the real shared
model transport and existing exact ask-confirmation source. None is silently
substituted by test fixtures, desktop/network permissions or repository merge
permission. Real provider/user-flow acceptance is outstanding.

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

## Test resource lifecycle

Owned PostgreSQL fixtures create a fresh UUID schema and retain its tables/rows;
local publication fixtures retain fresh private artifact directories. No fixture
cleanup selects a prior schema, container, directory or log. Database URL guards
run before pool construction, require the exact isolated loopback target and
reject URL options/fragments. Explicit pool configuration prevents connection URL
or PGOPTIONS overrides from escaping the new schema.

The missing-event negative uses a fresh task for which finish events were never
inserted. Invalid result content is a separate negative. Corrupt local receipts
use a fresh UUID and exclusive creation rather than replacing a successful file.
Security invalidation/revocation checks remain intact.

Loopback HTTP substitutes record protocol audit data in a fresh private directory
and close only the listener captured by that invocation, within authorized
recycling of newly created managed test resources. Audit JSON is data, not a
claim that its listener survives teardown. Existing resources expressly preserved
by the user are not targeted. Client pool shutdown does not stop the retained
PostgreSQL service or delete its schema.

Full CI may recycle its own newly created hosted test resources within the same
authorization. A ref update must not cancel a protected older run through workflow
concurrency. Historical green jobs are not evidence for later source changes,
and isolated contracts are not real provider/model acceptance.
