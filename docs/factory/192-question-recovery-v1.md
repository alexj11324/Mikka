# Execution questions: additive #192 backend contract

Status: implementation plan and consumer coordination contract, not a completed runtime or acceptance claim. Base: Factory consumer integration `e5d88921d4c6981535e2d8056cef503726d9f586`; current main inspected at `1f2832e3a72349037a594c22193204c71f114508`. Existing stage/candidate contract v1 and FactoryGate callback remain unchanged.

## Scope and invariants

Clear authorized work starts execute. Only material missing information or permission requires clarification; spec remains optional. Start-of-task clarify/resolve and execution questions are distinct flows. This increment repairs execution questions using the existing run handoff, Coordinator inbox, Factory transaction and Harness continuation. It adds no frontend, provider permission, approval grant, scheduler or replacement Harness.

An execution question belongs to one existing owner, issue, Factory task/attempt/candidate, original run and exact session. Its questionId is generated once by the local handoff tool and retained in that durable handoff/outbox across retries. The backend verifies the relationship against persisted rows; model arguments cannot assign ownership or substitute a session.

The existing local ask_human handoff ends a run with stopReason asked_human. Retain that historical stopped run and worktree; it is not a cancelled Factory task. The Factory task/attempt becomes waiting with its question reference. An answer starts a new continuation run linked to the original run/session and same Factory task/candidate. A fresh attempt records that continuation without erasing the question or old attempt. The new run is execution history, not a new logical task. Do not reuse retryOf (reserved for device-loss recovery).

Original session/worktree continuation is mandatory for a question answer. If unavailable, fail closed with a queryable blocked reason; do not silently start a new session or reset the task. Keep existing device-loss continuation fallback unchanged. The stopped waiting run has no running watchdog/lease to time out while the user considers an answer. Other independent runs remain schedulable.

## Persistent identity and state

Question identity: `questionId`, `userId`, `issueId`, `taskId`, `attemptId`, `candidateId`, `originRunId`, `originSessionId`, stage and original Factory revision. The task binding at the waiting transition is recorded separately. The canonical backend thread anchor is the existing task plus original run; question events and responses include both identifiers. This does not invent a new group conversation or claim that a frontend question widget exists.

Question kind: context, decision, permission or external. Status: open (Orchestrator assessment), waiting_user, answered, resuming, resolved, blocked, cancelled, expired or superseded. Question revision fences mutations. One question per stopped origin run; its handoff is replayable only with identical content and identity. The next question after continuation belongs to the next run and has a new questionId.

Answer identity: `answerId`, authenticated source (human or orchestrator), actor, original question binding/revision, canonical text/facts and payload fingerprint. An optional sourceEventId identifies the actual user_message consumed through the Coordinator. `continuationRunId` links the one created run. The answer is immutable after acceptance.

Question expiry is optional and backend-controlled. An expired question cannot be answered or continued. No polling job or arbitrary model-selected expiry is introduced; operations check expiry transactionally. Cancellation/revocation, task replacement and ownership/access changes are checked before replay and before dispatch.

## Backend operations

- `recordQuestion(tx, originRun, handoff)`: same transaction as run completion. Verify actual run/session/issue/Factory binding; preserve asked_human, create the question and a stable existing Coordinator event, then persist Factory waiting. Repeated completion/hand-in cannot create another question or downgrade an answered question. Legacy hand-ins lacking questionId use a deterministic backend ID from their run, never a fresh retry UUID.
- `listQuestions(userId, taskId)` / `readQuestion(userId, questionId)`: current owner and issue authorization, returning question state, binding, routing reason, original thread/run/session and continuation state. Query paths must make waiting recoverable after compaction/restart.
- `escalateQuestion(userId, binding, eventId, reason)`: record only the genuine unresolved items; stable event replay. The Coordinator can inspect authoritative issue/request facts first. Repeated escalation does not duplicate a user-facing question event.
- `answerQuestion(actor, binding, answerId, answer)`: actor source is derived by the adapter, never accepted from a model-supplied origin flag. Lock task, question and source run; verify current access, no stop/revoke, expiry, current attempt/candidate, and source provenance. Same accepted answer replays the original result; changed content/source/answer identity conflicts. A stale answer cannot apply to a later attempt/question.
- `continueQuestion(...)`: accept the answer, create a fresh attempt, enqueue through the existing #191 queue gate, attach server-derived original-run/session continuation metadata, bind it and record the question result in one transaction. Use the existing dispatch key derived from the new attempt and preserve #191 fingerprint/overlap rules. No queue-then-bind crash window. Replaying the accepted answer returns the same continuationRunId after current authorization/stop checks.
- `finishContinuation(...)`: reconciliation records resolved only after the persisted daemon session matches the expected original session. Missing/unavailable resume becomes blocked with evidence; no speculative success. A further question creates its own durable record, preserving the preceding answer and run linkage.

Only the initial execute/spec question path may be enabled until the corresponding trusted review/verify/monitor dispatch adapters retain their own read-only/check constraints. Unsupported stage continuation must explicitly block rather than bypass a consumer gate. Shared helpers are stage-neutral; #193/#195 consumers coordinate their adapters before claiming those paths accepted.

## Answers and permissions

For context questions the Orchestrator first reads existing issue/request facts. Its answer must cite access-checked persisted source facts; it may not invent a user's decision. The minimum backend implementation permits verified excerpts of the current issue or an actual authenticated source request. Unsupported provenance escalates instead of guessing. decision and permission questions require an actual human source. external blockers require the named condition to be resolved and existing runtime checks to pass.

A permission answer is explanatory input, not an IAM/provider/billing/publish approval. Existing dispatch ownership, repository, workspace, sandbox and #194 action/target/candidate approval checks still apply. The model cannot label itself human, convert an arbitrary user_message into an approval token, recover a revoked task or change a denied permission. The existing send-message action must distinguish authenticated human adapters from model/Coordinator adapters; a default source must never imply human approval.

No question-specific answer may be silently appended to an ended run and reported as delivered. Existing human task-thread send actions can resolve the unique active question for their addressed run on the backend. Coordinator answers must carry questionId and explicit source provenance. Live-run ordinary interjections retain their existing behavior; stopped runs without an answerable question fail explicitly.

## Planned files and integration ownership

Independent new files: `lib/factory/questions/{contract,store,http}.ts`, focused tests, and `drizzle/20261026190329_factory_192_questions.sql`. This is a new migration after the coordinated dispatch/stage/approval/monitor files; none of those migrations is renamed or reapplied under an alias.

Shared #192 files: Factory store/reconcile/dispatch/server; schema; Coordinator tools/steps/context/instructions; run completion and claim adapters; existing authenticated send-message actions; protocol handoff/assignment fields. Reuse existing Factory `finish(waiting)`, `retry` and `bind_run` inside the caller-owned transaction; existing stage/candidate action schemas do not need replacement. Dispatch gains an optional existing-transaction argument, preserving its current callers and checks. Shared Harness files: local mikka-mcp, run-context, strict-resume options in supervisor and CC/Codex adapters. Query/reply metadata must be exposed through existing backend task/run APIs without frontend changes.

Coordinate changes in Factory reconcile/dispatch/store, Coordinator steps/workflow and supervisor with #193/#195. Their gates keep the existing callback interface. #191 insertRunOnce, parameter fingerprint and overlap policy remain unchanged. Hook question handling before the generic stopped-to-cancelled branch; genuine cancelled/revoked paths remain terminal.

## Acceptance plan

1. Source contract tests for identity, kinds, actor-source separation, answer fingerprints and strict continuation; no fixtures claimed as runtime acceptance.
2. Disposable real PG17: full tracked migration bootstrap/reapplication; ten concurrent question/answer replays; competing answers; SQL interruption before ledger/queue/bind commit; reconnect replay; wrong owner/issue/task/attempt/candidate/run/session; active replacement, expiry, cancellation, revoke and deleted issue. Exactly one answer/continuation; zero partial queue/bind writes.
3. Actual isolated HTTP/session: owner and model-adapter boundaries, answers, reads after fresh session, replay, absent/foreign/expired/stopped questions, permission answer rejection for Orchestrator, and queryable blocked strict-resume failures.
4. Actual existing Harness tests: ask_human/questionId handoff persistence, stopped worktree retention, same-session continuation, unavailable-session refusal, cancellation and duplicate transport. Mocks/fake CLI tests are explicitly labeled.
5. Authorized fixed Preview: actual CC and Codex each ask, receive legitimate context/user answers in the correct task/run thread, resume the original session and finish; another independent task continues while one waits. Exercise restart and failed delivery. Real provider/Harness/Preview acceptance remains subject to existing authorization and #176 reliable wake; no deployment or new provider permission is attempted by this plan.

Until all applicable layers and #181 same-version integration pass, #192 and Draft PR197 remain unfinished. Public repository notes contain only product/code facts; private runtime account/task/session evidence stays private.
