# Group, Artifact and mailbox backend handoff

This candidate integrates main `8f8484ff3bf9a55f5c759d7e2316ab90c5fb854f` with the previously local `be91a0abc078a5f548d308dcb3a7e08411078eaf` series. It contains no Artifact UI. Review all consumers against this same candidate; combining separate passing PRs is not integration acceptance.

## Browser and worker contracts

All browser commands require the authenticated session, active workspace membership and active membership of the exact group. Workspace membership alone grants no group/Artifact access. Browser bodies cannot set Agent authorship.

- `POST /api/conversations/:id/artifacts`: strict discriminated commands `create`, `list`, `read`, `revise`, `thread`, `comment`, `send`, `accept`; exact schemas are exported as `artifactCommand` in `lib/artifact-review-store.ts`. Media types are Markdown, HTML and plain text. Version-sensitive writes bind `artifactId`, `baseVersionId` and SHA-256 `baseHash`. `send` additionally binds `threadId` and UUID `requestId`; save/comment alone never dispatches. Reuse the same request ID on transport retry. A successful send means queued work, not execution or acceptance.
- `POST /api/conversations/:id/review`: `grant`/`revoke` bind `agentId`; `work`/`cancel` bind `workId`. Only an Agent's owner can grant it; cancellation requires requester/group owner. Grant revocation and member removal fence late results. Directory ownership guards remain intact.
- `POST /v1/devices/:deviceId/group-reviews`: authenticated device transport with `poll`, `claim`, `check`, `complete`, `fail`. Claim derives the owning Agent/harness on the server. Checks/failures bind claim epoch; completion binds work, trigger, run and epoch. See `group-worker-route.ts` and `group-mailbox-runtime.ts`. Normal repository claim/complete routes reject group-review work.
- `POST /v1/mailbox` and owner browser `/api/mailboxes` routes reuse session mailbox/run-message storage; they do not implement linked private-DM history.

Errors use `{error: code}`: invalid shape 422, absent/foreign resource 404, forbidden action 403, version/hash or stale state conflict 409. Read Artifact responses include immutable versions, version-bound threads/comments, change requests with work status, runtime errors and separate human acceptances. A losing concurrent Agent proposal remains persisted without advancing the head. Consumers must display conflicts and outdated/orphaned anchors, never silently retarget them. Raw HTML is untrusted and requires isolated sandbox/CSP rendering; there is no generic Tiptap HTML anchoring contract.

## Deduplication and integration boundaries

Checked current main and open PRs on 2026-10-25. Main has not integrated this mailbox/Artifact series. PR #166 (`6a75f272fa3e318ebb37ef9119aaf5b1f1dd3623`) overlaps group message routing using a separate server-provider queue. It is not included: do not merge both enqueue paths unchanged or enable two responders for one trigger. Before composing them, select a single durable work owner and reconcile routing/corrections/lead semantics with the explicit grant model; repeat same-version authorization and dispatch tests. This draft does not close #108/#126.

PR #206's provider custody/account recovery and Factory PRs #196/#197/#199/#200/#203 are separate candidates, not dependencies silently imported here. No provider credentials, live invocation or deployment is authorized by this backend handoff.

Main's new repository-run lease reclaimer excludes `group_review`; the dedicated group claim lease/epoch mechanism owns recovery. New unpublished migrations were renamed, without SQL changes, after main's latest migration. Previously applied main migrations retain their names/content. A disposable database that applied the old local filenames must be recreated; do not replay renamed migrations into a persistent environment without explicit ledger reconciliation.

Known separate gaps remain: #110/MIK-15 `conversation_links` creation/maintenance, `agent_exchange` timeline markers and linked-message read API/member authorization are not implemented. Coordinator wake has no reliable compensation/outbox. No device-token revocation API is introduced. Ordinary run completion does atomically commit terminal state, run-token revocation and Coordinator event persistence through `SessionMailbox.complete`.

## Acceptance and live boundary

Use cloud Linux with disposable Postgres and controlled native executables. `MIKKA_DISPOSABLE_POSTGRES_URL`, `MAILBOX_TEST_DATABASE_URL` and `MIKKA_TEST_NATIVE_GROUPS=1` enable the real PG/HTTP/daemon suite. Browser identity/device registration are explicit fixtures; this does not certify OAuth or deployment. See `group-artifact-runtime.md` and `group-native-cli.md` for exact isolation and protocol contracts.

Real Claude Code/Codex inference remains blocked pending a reviewed scoped provider authentication and model-only egress implementation/configuration and separately authorized genuine execution. Docker networking stays `none`, no host auth/history/repository is mounted, and absent image configuration leaves work queued. Fake CLI success is offline adapter acceptance only. Frontend, design acceptance and live vendor acceptance are not completed by this draft.
