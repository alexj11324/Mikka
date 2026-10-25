# #208 existing Calendar entrypoint integration

Stacked candidate on #220 exact 6e40c5fbec66b4503021467ac31e37b60bc63d70.
Main remains 8f8484f; #204 head ba06c194fd03bd859a9fe63fbb4d5d9f27437f1d,
merged as 3d710624a82789bcef82a5ccf86723e36e0d3650.

## Actual application path changed

Existing Coordinator Google create_calendar_event tool -> durable
proposeAccountAction step -> pending-action-store.proposeAction -> calendar service
-> existing pending_actions proposal. Existing browser decidePendingAction server
action -> pending-actions.decidePendingAction -> calendar service -> operation ledger
-> pinned Composio Calendar adapter -> receipt/projection + Coordinator event.

Only create_calendar_event takes the new path. Other existing actions retain their
implementation and still require their own #177/#208 integration. Unbound legacy
Calendar proposals cannot execute; they can be declined and proposed afresh.

The trusted Workflow SDK getStepMetadata().stepId is persisted as intentKey in the
existing proposal row. SDK attempt numbers can change without changing the proposal
UUID/operationId. No model-supplied key or runId+action identity is used. One step
represents one logical proposal. A later independent step gets its own proposal.
This covers retries of the existing durable proposal step. New workflow wakes and
agent run retry chains are not automatically the same intent; parent must coordinate
an explicit originating-intent parameter if those entrypoints are added.

#221/#223/#224 currently change workflows/coordinator/steps.ts and workflow.ts, and
#221/#224 touch shared run/daemon files. Those files are untouched here. A future
worker entry must pass the original persisted proposal UUID from trusted structured
run context, not generate a new key in a retry prompt. The current Calendar tool is
Coordinator-owned and has no daemon implementation to silently patch.

## Binding and execution authority

pending_actions remains the proposal/decision source, extended with intentKey and
operationBinding (provider, exact account, tool version, canonical payload digest).
operationId is the existing proposal UUID. Ledger is the sole execution authority;
pending_actions done/result is a repairable projection. No new approval or publication
ledger. Proposal-revision digest is an explicit alternative to Git candidateSha;
calendar actions do not pretend to have a Git commit.

#204 operates in the person's connected account, not a team workspace. The ledger
scope is explicitly personal:<authenticated user ID>. There is no fabricated team
workspace or cross-database membership claim. Future workspace operations need their
actual domain authorizer. Account is selected before approval, frozen, and checked
again before send. A replacement account is never substituted. Existing UI does not
display this frozen account yet; explicit account/status presentation is Claude's
remaining frontend dependency.

All decision/execution paths lock ledger -> session -> proposal. Approval and current
session are rechecked before claim and invoke. An invokedAt marker commits before the
provider call, so an invocation cannot be repeated after uncertain persistence.
The actual provider call runs while authority locks are held. The native adapter
rechecks current authority through the same transaction AFTER asynchronous account
lookup and immediately before tools.execute; expiry during preflight cannot send. Revocation committed
before that transaction rejects the send. A later revocation waits and cannot claim
to cancel an already invoked action. Session expiry is checked before send; in-flight
requests cannot be recalled if authorization expires afterward.

Calls have a 30-second deadline. AbortSignal reaches the adapter; a delayed account
lookup checks abort again before tools.execute and cannot send after timeout. A request
already sent may still complete remotely: it stays unknown and is never resent.
The Composio tool contract used here does not establish a supported idempotency field
or lookup-by-key, so the real adapter does not invent one. Its unknown results remain
running/uncertain for manual verification. The local provider supports independent
lookup and validates successful reconciliation. Real provider readback remains blocked
pending the explicitly authorized target and supported lookup contract.

Negative lookup during a concurrent approval does not invalidate the first caller's
claim. Positive readback can settle the ledger; succeeded replay repairs projection.
Running Calendar entries remain in the owner-scoped list, and one attention event
reports uncertainty. Clicking the existing approval again only reconciles once a
claim exists; it cannot resend. Decline of an already invoked operation is refused.
Claude still owns a dedicated uncertain/reconcile UI; no UI file is changed.

## Validation boundaries and retention

Integration tests call the actual proposeAction/decidePendingAction/listPendingActions
functions with real PG, Better Auth cookie authentication and HTTP provider requests.
They do not substitute a duplicate application service. A synthetic SDK context runs
the real getStepMetadata implementation; this is not a deployed Workflow scheduler
restart test. The HTTP host is a fixture around the application functions, not a
claim that a Next deployment or human OAuth flow was accepted.

Cases: ten concurrent step retries and decisions, conflicting payload, lost HTTP
response, SQL receipt failure, committed revoke after durable invocation reservation,
legacy decline, expired/foreign proposal, pinned-account change, uncertain listing
and Coordinator event, abort while account lookup waits, and session expiry during provider preflight. Earlier concurrency
reconciliation invalidated the live claim; the negative-lookup behavior was corrected
and retested. Independent review additionally required cancellation, legacy and
visibility and final pre-send expiry fixes; all are retained in the implementation and regression cases.

All schemas/records remain; test triggers are disabled rather than dropped. No real
provider request, deployment, merge or cleanup is performed. No raw session/token,
provider content or model trace is published. #220's release checklist still applies:
parent-coordinated integrated preproduction, actual approved provider/user flow,
production verification and sanitized genuine PR video remain unfinished.
