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
