# #208 / #177 interface handoff (read-only wiring audit)

Baseline main: 8f8484ff3bf9a55f5c759d7e2316ab90c5fb854f; #204 is already merged.
No shared Factory, daemon, provider or frontend file is changed by this handoff.

## Concrete current call path

1. `workflows/coordinator/workflow.ts:52` builds Google tools. The proposal callback
   passes only userId/action/input to `steps.proposeAccountAction`.
2. `workflows/coordinator/steps.ts:98` is a durable workflow step, but its application
   call to `lib/pending-action-store.ts:proposeAction` has no persisted intent key.
3. `proposeAction` parses input and inserts a new random pending_actions UUID every
   invocation. The row has owner/action/input/decision status; no workspace, selected
   provider account, immutable candidate, or cross-proposal uniqueness.
4. `app/actions/pending-actions.ts` gets the authenticated user. It passes userId
   and proposal ID to `lib/pending-actions.ts:decidePendingAction`.
5. `decidePendingAction` CASes pending to running, calls `runComposioAction`, then
   stores done/failed and emits a Coordinator event. A provider success before its
   result write leaves running; exceptions are not distinguished as uncertain.
6. `lib/composio-actions.ts:executeComposioAction` queries active accounts again,
   chooses the sole account and tool version at execution, then calls tools.execute.
   No stable operation key or remote readback protocol is passed. A reconnect could
   change the sole account after the person approved.
7. `lib/run-leases.ts:reclaimLostRun` creates a new UUID with retryOf pointing to the
   old run. `latestCheckpoint` walks that chain for work artifacts only. Existing
   worker-token auth is run-scoped. No logical external intent is carried there.

The Coordinator proposal path and daemon retry chain are distinct today. Merely
hashing rootRunId plus action would collapse multiple legitimate identical actions
and would not solve repeated Coordinator proposals.

## Proposed ownership and interfaces

#177 owns proposal identity/approval and selected account; #208 owns execution state
and uncertainty. Keep pending_actions as the proposal/decision source, not another
execution ledger. Its displayed done/failed fields become receipt-derived projections,
repaired by rereading operation_ledger. No new approval table or publication reservation.

At the trusted originating workflow boundary, persist a logical intent key BEFORE
provider execution or agent retry. Suggested input (not model-supplied authorization):

```ts
type ProposeAccountIntent = {
  ownerId: string // authenticated context
  workspaceId: string // verified domain scope, no default fabricated workspace
  intentKey: string // stable origin event/workflow + durable action slot
  action: string
  input: unknown
  accountId: string // resolved owner-bound account shown at approval
  candidateSha: string // immutable actual candidate when applicable
}
// Atomically insert-or-read proposal keyed by (ownerId, workspaceId, intentKey).
// Same key + different canonical payload/account/target must conflict.
// operationId = the persisted proposal UUID; no second random operation identity.
```

A retry carries the existing proposal/operation ID in durable structured task context,
not prompt text. Do not mint a new intentKey because runId changed. Independent user
requests get distinct slots even when their payloads are identical. Owner and workspace
checks precede returning old proposal IDs. Invalid/truncated/cross-owner retry chains
must fail closed; do not infer ownership from retryOf alone.

The current ledger requires candidateSha. Email/calendar proposals may have no Git
candidate: the shared contract must add an explicit proposal-revision/payload-digest
variant before integrating those actions. Never fabricate a Git SHA or reinterpret
the field silently. Git publication keeps its exact immutable commit binding.

The approved execution bridge must load the persisted proposal and exact account,
canonical payload digest, target and candidate, then reserve that operation ID and
claim via ledger. Existing pending-to-running CAS remains the human decision; it
must not itself be an alternative provider-execution gate. A crash after decision
but before reserve is recoverable from the same proposal ID; a crash after claim
requires lookup/uncertain, never a second send. Run IDs belong to attempts only.

Use `withOperationSession` only for authenticated human browser operations, composed
with the real domain binding authorizer. Worker operations need existing worker token,
run lease and owner/workspace checks instead; do not fabricate a human session.
Workspace tables currently target DATABASE_URL while ledger/session/pending_actions
target the application pool: do not assume a cross-database atomic membership lock.
The scope owner must supply a revocation/fence contract before enabling that path.

Provider adapters need explicit `executeApproved({operationId, idempotencyKey,
accountId, canonicalPayload, fence})` and `lookup({operationId, idempotencyKey,
accountId, target})`. Validate the account still matches; never silently select a new
one. Declare provider idempotency/lookup support per action. Lookup absent/ambiguous
means uncertain; no automatic send. Preserve the existing #203 publication authority
rather than wrapping it with a competing reservation. Claim-to-effect fencing and
in-flight revocation limitations still require an execution boundary design.

## Why propagation is not patched in this branch

It requires coordinated changes to #177's proposal schema, Coordinator tool context,
approval decision and provider adapter; worker propagation additionally touches shared
run/daemon contracts. None can be solved by changing only this ledger without creating
an unused duplicate intent store or a misleading prompt convention. These files are
left untouched. This is a concrete interface handoff, not a claim of system wiring.
