# Personal Factory intake on main

This extraction starts from main 4f52bbb2161d7016e95b95b5db3e3aa05afb89a2. Main has no Factory tables or dispatcher; PR316 remains an unmerged broad candidate. This PR reuses the existing v1 stage/binding vocabulary and transactional intake state, not the Skill, reviewer, publisher or monitor implementations from that candidate.

## Frozen intake interface

`intake_factory_request({sourceEventId,title,body?,rationale,missingInformation?,missingPermissions?,needsSpec?})` authenticates owner and actual Bot from the existing tool host, verifies the original personal `user_message`, and creates the issue through main's existing idempotent issue mutation. One source request maps to one durable issue receipt (`factory-intake:<sourceEventId>`). If interrupted after issue creation, the same frozen request reuses the issue and completes routing. A changed issue body conflicts with the existing receipt. This is recoverable across two commits, not an atomic issue-plus-route transaction.

Stage selection: any concrete missing information or permission → `clarify/waiting`; otherwise optional `needsSpec` → `spec/pending`; otherwise → `execute/pending`. A clear task needs neither spec nor a new approval step. These are routing states, not proof that a worker has executed.

`get_factory_task({taskId})` returns `{contractVersion:1, task, attempts, candidates}`. Task binding remains `{taskId,issueId,attemptId,revision,candidateId}`. `candidateId` is null at intake. Attempt IDs and ordinal/position are durable. Later candidate/run/evidence consumers must preserve this identity; this extraction exposes no finish, advance, candidate or bind-run mutation.

`resolve_factory_task({binding,eventId,change:{action:'resolve',sourceEventId,rationale,missingInformation,missingPermissions,needsSpec}})` requires a subsequent actual personal event in the same owner/Bot chat. Peer/runtime events and another Bot's user events cannot become answers. Resolution records the original source reference and moves to a new pending attempt only when missing items are resolved. It never grants execution or publication permission. Replays are payload-checked; stale bindings and cancelled/revoked tasks reject.

`list_factory_requests({})` exposes actual source IDs and original text within the host-owned personal chat. Existing provenance and compaction semantics are unchanged. No model-supplied owner, Bot, approval or source classification is accepted.

## Compatibility and rollout

`POST /api/coordinator/messages` remains strictly `{text,submissionId?}`. Do not send question/approval fields, strip them into ordinary messages, or reinterpret submission IDs as question IDs. This PR has no execution-question answer endpoint. The old execution question/run/session contract remains unavailable on main until a separately coordinated integration preserves current worker and provenance boundaries.

Both `MIKKA_FACTORY_ROUTING_ENABLED=1` and existing `MIKKA_ISSUE_TOOLS_ENABLED=1` are required for intake tools. Registering capabilities does not expand a frozen execution grant. Existing stored definitions must explicitly include a capability before instrumented execution can use it. No runtime flag, definition, provider authorization or real resource is changed by this PR.

Migration: `20261028070000_factory_192_routing.sql`, application database only. Do not also import old candidate aliases for these tables. #193–195 retain ownership of their validators/adapters. Current main's queueRun has no #191 request-key/transaction contract; this PR does not replace it or claim atomic run dispatch. Native Coordinator and real-model evaluation remain off for this work.

## Acceptance boundaries

Verify route choice, durable issue replay, exact owner/Bot/source, actual later user response, stale/replayed events, cancellation/revocation and reload through isolated SQL and the real tool adapters. Source fixtures and disposable PostgreSQL are backend evidence. Real user chat/model behavior, fixed Preview, worker dispatch and execution-question recovery are not established by these checks and remain tracked under #192 and its integration dependencies.
