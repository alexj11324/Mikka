# Monitor integration checkpoint

Base: main 4f52bbb2161d7016e95b95b5db3e3aa05afb89a2.
This base has no Factory stage store or publication reader. The fingerprint module
is only an independently tested prerequisite, not a registered validator.

Required coordinated interfaces before runtime integration:
- #192 frozen 283a642: createFactoryStore(pool, authorize, botId = null).
  The third argument is NOT gates. Intake route/read/list and resolve/cancel/revoke
  are available; monitor gate registration, dispatch and cycle CAS remain absent.
  Do not install the old monitor store wiring against this signature.
- #194: frozen readFactoryPublicationReceiptV2(tx,userId,taskId,candidateId)
  equivalent, with action/target/targetEnvironment/publishedAt and verifiedTarget
  operationId/environment/SHA/reference/observedAt plus provider teamId/projectId/
  deploymentId/publicationId/bindingHash. Production must remain explicitly
  deploy_production + production-deployment. Missing or uncertain receipts block.
- #193: frozen same-phase question ancestry validator for both pass and fail,
  preserving candidate/session/owner fences. Monitor will consume the contract,
  not implement independent review/verification rules.

A GET is not assumed harmless merely because of its method. Provider probes must
use fixed read-only metadata endpoints, reject redirects and bind immutable SHA,
operation and current alias before/after health. Health endpoint implementation
must be inspected for mutation, billing, model invocation and scheduler wakeups
before real target probing. No real provider call is part of this checkpoint.

Subsequent acceptance must demonstrate durable concurrency/replay dedupe, original
issue linkage, permissions/cancellation and same-version verified recovery using
existing issue/event/sync paths. No replacement worker or stage source is added.
External issue writes and migrations are not authorized by these unit tests.

Verified #193 source 3ee0c745a99aba6c65c64a06007197a375a3d1a2:
`factoryCheckIndependent(tx: Pick<PoolClient, "query">, task: FactoryCheckTaskIdentity, runId: string): Promise<boolean>`.
Contract version 1 returns false for monitor. true means ancestry/independence only,
not pass or authorization. Monitor support awaits its owner; no local bypass.

`planMonitorIssueAssociation` is a pure proposal, not a validator or durable dedupe
store. Repeated links coalesce; ambiguous links block. Original issue scope is
checked. New issue is only proposed, never created. It cannot close/recover issues.

V2 consumer source dependency: #194 commit
2ff475c47e47d2a3e4a4e9440031512a06a8aebc, lib/factory/publication-receipt.ts.
monitor-v2-binding imports its actual FactoryPublicationReceiptV2 type directly;
no substitute receipt schema or reader is introduced. This minimal branch does
not contain #194's files yet: source-only tsx tests erase type imports, so their
success is NOT evidence of typecheck/build or a runtime reader invocation.
Normal typecheck awaits coordinated availability of that dependency on the base.

The pure validator requires provider identity, immutable target and candidate
SHA/repository, explicit action/environment, observation time after publication,
and production alias before/after. A stable bound 5xx/invalid health body is
unhealthy; moved identity, unauthorized status or missing health blocks. READY
alone never proves health. No transport is registered, no real GET is performed,
and authorized transaction/ancestry validation remain mandatory caller duties.

Coordinated stack now includes the full unchanged #194 commit 2ff475c.
PR base is codex/194-approval-main-20261028; only #195 additions are its diff.
The earlier missing-type-dependency limitation is resolved. Required CI now runs
monitor pure tests and actual V2 reader/consumer PG tests using #194 fixtures,
plus normal full types/lint/build. This does not register runtime monitor gates.

Current dependency base: 5ff814aa0c4cb85d1134444e32d0f4007ac360e2 combines
#194 a75380459717140f6b0fc3dba17cc09eab39e458 and #193
4440eed4d7a1440c76ad779dc896c44b0c846847. Receipt reader bytes are unchanged;
ancestry v2 is now imported and called by consumeMonitorObservation for both
healthy/unhealthy paths. No unsupported-stage bypass is present.

#192 required entry: invoke consumeMonitorObservation(tx, currentLockedTask,
incidentInput, verifiedObservation, configuredProductionOrigin) only after current
owner/Bot/workspace/issue authorization, cancellation/revocation, binding revision,
attempt/candidate/run/session and frozen assignment checks. The same transaction
must claim the event and perform route/apply/cycle CAS. Return value is an incident
ID/replay flag, never an instruction to advance or close. Fingerprint/checkKey and
workspaceKey must be derived from trusted current assignment; original issue comes
from that task. Recovery needs the original incident fingerprint, independently
verified new candidate plus its approved publication, and the same configured
check/target. This callback has no dispatcher or alternative phase state.

Schema proposal docs/factory/schema-proposals/195-incidents.sql is NOT a tracked
production migration. It creates two new tables and indexes, without altering old
migration history. Its incident unique key scopes owner/workspace/fingerprint;
observation owner/event key prevents echo/replay count inflation. Event locks are
acquired before incident locks. Transactions roll back both records atomically.
Recovery evidence only sets recovery_observed; later failure reopens the internal
incident. Neither state writes/automatically closes any external or internal issue.
A future registered migration requires coordination against then-current main and
approval for actual database application. No #192 migration alias is imported here.

Lifecycle integration now consumes #192 12c7c50 source. createFactoryMonitorConsumers
exports configure, validateCheck, gate, reconcile matching actual owner callbacks.
readProbe is a required trusted persisted-artifact reader; missing proof blocks.
No model handoff field supplies a probe. These exports do not enable flags.

Exact remaining host seam: guardFactoryClaim and ordinary runtime callers currently
call factoryRuntimeForBot(botId) without these consumers. The #192 owner must install
configure.monitor, validateCheck delegation, lifecycle.gates.monitor and
consumers.monitor together; third store arg remains botId, lifecycle is fourth.
Store invokes stage gate for passed only; monitor reconcile therefore validates
receipt/probe for both passed and failed before applying finish in the same tx.
The trusted readProbe implementation must verify report-body/run-chunk authenticity;
a reference digest alone is insufficient. No real probe transport is registered.
