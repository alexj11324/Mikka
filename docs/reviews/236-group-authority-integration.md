# PR236 + PR221 trusted group execution integration

Base: PR236 b960a94cf8cc87757ea4902ec83d984e5b56d0e7. Merged source: PR221 50dadf52a36b3ee34b4ed48006890288b190c4bc. Work is isolated from both source branches. No frontend changes.

## Authority boundary

Issue runs retain PR225's currentRun and deliver permission/transaction checks in lib/mcp/worker.ts. Generic MCP additionally rejects group_review, including a group run maliciously attached to an otherwise valid issue. A missing issue never grants authority.

Group runs use the dedicated device group-reviews transport. lib/group-worker-authority.ts binds the authenticated device token to an enabled device and holds those rows through the application transaction. lockedGroupRun requires a persisted conversation_work/run/Agent/grant/human-trigger/mailbox assignment, matching workspace and owner, a dedicated group mailbox and no private session/repository context. Existing operation checks enforce active members, grant epoch/revocation, work status, cancellation, lease expiry and claim epoch. The compatibility group-reply endpoint uses the same authority wrapper. Completed reply replays recheck membership/grant authority.

Workspace membership row locks remain held until the application transactions complete. This prevents a concurrent revocation from completing before a protected write commits. Application and workspace database commits are not distributed-atomic; a workspace commit failure after an app commit remains a limitation, as in the issue path. Lock timeouts fail closed; callers must handle retries. No generic credential or repository capability is introduced for group workers.

## Conflict resolution

Five textual conflicts were resolved individually: agent tools and coordinator retain credential tools plus mailbox tools; daemon MCP/run context retain credential bridge/proxy handling plus mailbox transport; worker MCP retains the PR236 issue authority implementation. MIT provenance from PR221 is preserved.

PR166 is not included. Its direct server-provider group-round dispatcher must not be stacked as a second executor. Retain one durable work owner (conversation_work/mailbox), then adapt lead/round policy to that work intent. Reconcile schema/store/package overlap separately. Do not replace the generic MCP verifier with PR221's low-level verifiedWorkerToken helper.

## Evidence and deployment boundary

Local disposable Postgres 17 and controlled native CC/Codex binaries exercise the daemon/HTTP result path. These are not real vendor inference. Existing native isolation remains network-none and requires explicit compatible processor configuration; production authentication/egress is not configured or authorized by these tests.

The focused independent manual review found no confirmed defect in this new composition. It did not reopen or sign off PR225's original blocked independent review. Exact test counts and final HTTP results accompany the delivery report. Remote CI, unified preproduction deployment, actual user acceptance and a redacted production acceptance video remain separate gates coordinated by the parent. No production data or deployments were touched.

Final local evidence (2026-10-25): combined PG/HTTP/offline-native suite 77/77; final expanded authority/race suite 5/5; daemon suite 74/74; credential bridge test 1/1; migration-order test 2/2; actual built Next HTTP tests 2/2 (dedicated group authority and existing issue worker authorization). Next production build completed with CI loopback origin configuration; host and daemon types passed. Fresh migration-first E2E setup and replay passed. Fake native binaries, not live models, supplied all native results. The built Next HTTP checks used a separate local disposable fixture database and ephemeral test-only signing secret. No acceptance media is represented as production evidence.

The final infrastructure review identified a pg URL query-host override in the existing disposable setup guard. Setup now rejects all URL query parameters/fragments before migration or connection. A parser-independent subprocess regression verifies four override/fragment inputs fail at the guard (1 test passed); normal local migration replay still passes. CI's test:e2e:setup includes this regression.
