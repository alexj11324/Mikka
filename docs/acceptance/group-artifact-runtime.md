# Mixed group and Artifact backend delivery

Base: `5a0e1c411f487fee433c48414f7130d0d58dad92` (fetched `origin/main`).
Branch: `feat/group-artifact-runtime`. Acceptance host: disposable cloud Linux, 2026-10-24. No production/Preview execution, paid models, invitations, credentials, pushes or deployments.

## Implemented

- Existing human group sends atomically persist a message and one durable `conversation_work` intent per explicitly mentioned Agent. Existing deterministic `mentionRoute` is reused; unaddressed messages do not invoke a routing model. Optional `clientMessageId` deduplicates retries, rejects different payloads under the same key, and preserves the original message ID.
- Agent owners explicitly grant their own Agent to a conversation; an active human member can address an Agent shared by another group member. Agent ownership directory guards remain intact. New creator-owned Agent memberships get a conversation grant. Existing Agent memberships remain inert until explicitly granted; migration replay does not silently share them.
- Work captures grant identity and precise database membership timestamps. Dispatch/reply/cancellation/removal/revocation serialize on the conversation lock. Agent ownership and active workspace/group membership are rechecked at dispatch and reply. Revocation/removal cancels affected work, stops only bound dedicated runs, and removes undelivered input. Agent replies create no further work (automatic chain bound: zero).
- `dispatchReviewWork` accepts a transaction-only adapter and uses the work UUID as the unique run UUID. The supplied `runMessagesAdapter` writes to existing `run_messages` in the same transaction; retries cannot dispatch twice. It rejects private/repository runs. Mock runtime acceptance exercises enqueue, trusted reply, rollback/retry, and completion through this adapter.
- Artifact identity is conversation-scoped (workspace scope is inherited from that conversation). Markdown, HTML source and plain text have immutable SHA-256 versions. A database trigger rejects version update/delete. Threads retain original version, quote, context and source range; replies are separate persisted comments. Saving comments does not dispatch. Explicit send creates a visible human trigger and a version-bound change request to the Artifact's selected Agent.
- Trusted runtime replies bind work, run, Agent, grant and trigger. Proposed revisions must match the original request's Artifact/base/hash. Concurrent proposals retain the losing immutable candidate and show a conflict without changing the current head. Runtime completion never writes acceptance. Any active human group member may explicitly accept the current exact version/hash; acceptance has separate human audit records. Existing acceptance remains attached to its old version when another revision arrives.
- Source anchors do not migrate. A changed head marks the original anchor outdated; invalid quote/range/context marks it orphaned. Raw HTML element identities fail closed as orphaned until a renderer can validate them. Generic HTML does not use Tiptap anchors. `ARTIFACT_HTML_POLICY` defines an empty sandbox, restrictive CSP and no privileged postMessage bridge for a renderer. The committed backend does not render HTML; separate frontend edits are paused and uncommitted.

## API and integration contract

Existing `POST /api/conversations/:id/messages` accepts `body`, optional `clientMessageId`, `mentions` and `replyToId`. It accepts no authored identity fields.

`POST /api/conversations/:id/review` accepts strict commands:

- `{ action: "grant" | "revoke", agentId }`
- `{ action: "work" | "cancel", workId }`

Grant requires ownership of the Agent and active group membership. Revoke requires its owner or the group owner. Cancel requires its requester or the group owner. Work status is visible only to active group members.

`POST /api/conversations/:id/artifacts` accepts strict commands:

- `create`: `title`, `mediaType`, `currentAgentId`, `content` → Artifact ID and initial version/hash.
- `list`, or `read` with `artifactId` → scoped history, anchors, comments and human acceptances. Content remains untrusted source.
- `revise`: `artifactId`, `baseVersionId`, `baseHash`, `content` → human revision.
- `thread`: the same exact base plus `anchor`, `body` → persisted thread; invalid anchors are visibly orphaned.
- `comment`: `artifactId`, `threadId`, `body` → human thread reply.
- `send`: `artifactId`, `baseVersionId`, `baseHash`, `threadId`, `requestId` → idempotent explicit work intent. Stale/orphaned threads cannot send.
- `accept`: `artifactId`, `baseVersionId`, `baseHash` → explicit human acceptance. Hash/head conflicts return HTTP 409.

`POST /v1/runs/:runId/group-reply` uses existing device authentication, never browser session authentication. It verifies device/run ownership and `group_review` kind before accepting `{ workId, triggerMessageId, body, proposal? }`. Proposal has `artifactId`, `baseVersionId`, `baseHash`, `content`. The authenticated route supplies the run identity; body-supplied identity fields are rejected. A repeated completion returns its persisted outcome and cannot duplicate the reply/revision.

## Mailbox integration and runtime capability

The internal mailbox source handoff is resolved. Candidate source from `8cb80b11276b6314a6e15077b39506237790c305` over exact main was independently verified (patch SHA-256 `49b2b3f88088f5cd922d866eda91a003a42492802114c9d8456a2864146738eb`) and imported in `e77e0f8`; MIT provenance is retained. Its original Git object is not reproduced by importing a source-only patch.

`lib/group-mailbox-runtime.ts` reuses `SessionMailbox` and existing `run_messages` storage. A new group kind has the actual authorized conversation workspace and a fresh identity per work intent. It is unavailable through private/peer mailbox discovery, send, owner policy, stop and generic completion. Generic repo claims, commands and run mutation also exclude group reviews. Backfill preserves existing group mailbox identities while removing private discovery and automatic wakes.

`POST /v1/devices/:deviceId/group-reviews` uses existing device authentication and strict `poll`, `claim`, `check`, `complete` commands. No caller-supplied owner/workspace is accepted. Bounded polling recovers pending work and atomically dispatches it; concurrent claims receive one 90-second lease. Completion supplies `claimEpoch` as well as the run/work/trigger/base bindings. Expired attempts can be reclaimed; old epochs cannot write. Reply/revision, work status, mailbox ACK and terminal run state commit together. Cancellation marks only dedicated runs cancelled. Checks propagate grant/member/workspace revocation and abort a running worker; reply checks reject late writes.

The daemon's existing authenticated HTTP link exposes this transport. `DaemonOptions.groupReviewProcessor` explicitly enables its separate JSON-only batch executor; omission leaves group work queued and makes no provider call. It does not reuse private/repository adapters, native CLI home, session resume, MCP/tool tokens, tools or publication. A processor must be supplied by a capability-limited host and honor AbortSignal. There is intentionally no default live provider or native CLI adapter. The controlled acceptance processor executes inside Docker without host mounts, network, writable root, Linux capabilities or inherited credentials. Actual live provider inference is neither enabled nor claimed. Runtime capability UI remains false until an actual configured runtime is made available; frontend is still paused.

Workspace membership lives in another database. Checks use the existing directory adapter at dispatch, claim, running checks and completion, but cannot form one atomic transaction with concurrent external workspace suspension. Group-local removal/grant revocation is serialized; the suspension propagation window remains a documented limitation.

Frontend implementation exists separately in the working tree after inspecting authorized Claude references. It has not been checked against the full Figma product design and is paused pending design alignment. No frontend changes are included in this backend delivery; browser functionality checks do not constitute design acceptance. Existing Issue/Tiptap comments were inspected; this source-version contract does not claim their Yjs anchors work for arbitrary HTML. Invitations and credentials remain separate tasks.

## Original backend acceptance evidence

A local disposable `postgres:17` container on this cloud Linux machine bound only `127.0.0.1:55437`, database `mikka_review`. Each suite created and dropped its own random schema. No user database was used. No model/provider calls were made.

Commands (direct installed binaries avoid pnpm attempting to write its package-manager store outside the permitted workspace):

```sh
MIKKA_DISPOSABLE_POSTGRES_URL=postgresql://postgres@127.0.0.1:55437/mikka_review node --import tsx --test lib/group-conversations.test.ts lib/group-artifact-review.test.ts lib/coordinator/group-routing.test.ts
node scripts/check-migrations.mjs
node --test scripts/check-migrations.test.mjs scripts/migration-order.test.mjs
node_modules/.bin/oxlint --deny-warnings
node scripts/lint-ui.mjs
node --test scripts/ui-policy.test.mjs scripts/interaction-policy.test.mjs
node_modules/.bin/tsgo --noEmit
```

Results: 34 backend group/Artifact/routing tests passed with zero skips; 11 migration tests passed; 28 migration files validated; oxlint passed; UI policy passed; 149 UI/interaction-policy tests passed. Acceptance includes migration concurrency/replay and preserved legacy history without privilege backfill, cross-owner/workspace/group/Artifact boundaries, suspended/removed members, revoked/regranted grants, spoofed authors, cross-group mentions/replies, duplicate/concurrent sends and dispatches, rollback/retry, bound reply deduplication, cancellation, late writes, actual lock-wait races (including a stop committing during reply validation), concurrent immutable revisions, exact human acceptance and stale/orphaned anchors.

Typecheck: the original supplied dependency tree produced the same 23 diagnostics on base and backend. After restoring declared dependencies in ignored node_modules, a source-only comparison against exact base reports the same three existing year-picker diagnostics. The full generated-context check additionally reports an unchanged Telegram route implicit-any diagnostic; no feature-source diagnostic was added. Full production build and real mailbox acceptance are not claimed. The backend test is included in `test:groups` so existing disposable CI service runs it.


## Earlier verification history

The earlier source-handoff wait is resolved by the verified 8cb80b1 import and integration described above. Original backend commits ab944bb, 8ec169b and efce5c8 remain preserved. The following notes describe earlier verification, before actual mailbox execution was integrated.

Independent follow-up applied the real `scripts/migrate.mjs` runner from an empty PostgreSQL 17 installation to separate disposable `mikka_review` and `mikka_workspace_review` databases. All 28 migrations applied successfully. A second runner invocation applied zero migrations. Both runs used explicit loopback URLs for both database targets, never inherited user database configuration. The 32-test suite passed afterward; the subsequent runtime stop-race regression increased the total to 33 passing tests.

Runtime live validation now locks the dedicated run row through reply commit. A stop transaction already holding that row is observed after the wait and prevents reply/revision writes. The regression verifies an actual database lock wait and no persisted late reply. Lint remains clean and typecheck still matches the exact base's diagnostics.


## Backend follow-up after frontend pause

Read-only `GET /api/conversations/:id/members` requires active workspace and group membership. It returns only group/member display metadata and an explicit `agentExecution: false` capability. Revoked/inaccessible Agent grants have no display name. `GET /api/conversations/directory?workspaceId=...` requires active workspace membership, offers active humans and only the caller's own Agents, and returns no private Agent configuration or credentials. Artifact reads include authorized change-request status so clients can distinguish pending work from completion.

Ownership checks now reuse the already-held application transaction connection. Otherwise concurrent requests could exhaust the pool while each waited to acquire a second connection for the same ownership query. A real two-connection pool regression verifies eight concurrent sends and group metadata reads while preserving owner checks. Workspace checks still use the separate existing workspace database.

UI edits, selection helpers and UI test-script edits are deliberately excluded from this backend commit. They remain preserved for later Figma alignment. No frontend or design acceptance is claimed.


## Integrated cloud Linux acceptance

A combined run passes 71 app/Postgres/routing/mailbox/prompt tests with zero skips, including nine new integration checks. Real HTTP uses the same production handler core with a controlled identity fixture and real separate app/workspace Postgres databases. A Docker-isolated fake worker consumes the actual durable mailbox envelope and returns through the actual trusted completion handler. This is not a real device login, paid provider call or frontend/design acceptance.

Coverage adds exclusive claims, stale lease recovery/epochs, private mailbox exclusion, cross-owner/spoofed worker requests, active workspace checks, mid-execution revocation abort, same-conversation reply, exact acceptance, concurrent base conflict, ACK/terminal/revision rollback and retry, additive group mailbox backfill/replay, and no private Coordinator notifications. Existing mailbox and daemon tests remain intact. All 30 migrations apply through the real migration runner on empty disposable databases; replay applies zero. Source typecheck matches the exact base's three year-picker diagnostics; daemon typecheck passes. See the separate integration delivery report for final commit and command logs.
