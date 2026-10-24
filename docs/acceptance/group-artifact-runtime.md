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
- Source anchors do not migrate. A changed head marks the original anchor outdated; invalid quote/range/context marks it orphaned. Raw HTML element identities fail closed as orphaned until a renderer can validate them. Generic HTML does not use Tiptap anchors. `ARTIFACT_HTML_POLICY` defines an empty sandbox, restrictive CSP and no privileged postMessage bridge for the future renderer; no HTML renderer was introduced.

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

## Pending integration, not enabled

Action: enable a production worker consuming `conversation_work` through an isolated mailbox session adapter. Target: the separate independent-session mailbox candidate, reported as branch `adapt/warp-default-prompts`, commit `2db17f7fd47c35771d8633d0b0ad488effd4cf31`. Status: pending; that object/branch is absent from this checkout. No denial or uncertain external mutation occurred.

The current main repository daemon claim requires a repository and issue. It must not be reused for group work: that would expose the owner's private runtime context. No production worker is registered, so new work remains durable `pending` until the mailbox integration is supplied. `existingGroupRuntime.enqueue` deliberately reports `mailbox_adapter_required`; its live check serves authenticated replies after proper adapter integration. Do not treat mocked runtime acceptance as live Agent execution.

The mailbox adapter must transactionally prepare a fresh `group_review` run and enforce a group-only session with no private history, repository, tool credentials, standing instructions or privileged tools. This is a runtime capability boundary, not a prompt-only guarantee. It must consume the existing `run_messages` envelope, separate its trusted contract from `untrustedData`, honor stop/revocation before delivery, and submit replies through the authenticated route before finishing the run. No additional generic message bus was added. Scheduling, durable polling/recovery and actual mailbox-session execution remain part of that reconciliation.

Workspace membership currently lives in another database. Checks use the existing directory adapter at each boundary; they cannot form one atomic transaction with a concurrent external workspace suspension. Group-local removals/grant revocations are serialized and tested. The mailbox integration must also recheck authorization before delivery and stop affected runtime work when workspace suspension propagates.

Frontend pending actual Claude reference screenshots/parent decisions. No speculative layout, standalone mailbox UI, shell navigation or invitation/credential implementation was added. Existing Issue/Tiptap comments were inspected in the prior audit; this source-version contract does not claim their Yjs anchors work for arbitrary HTML.

## Acceptance evidence

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

Results: 33 group/Artifact/routing tests passed with zero skips; 11 migration tests passed; 28 migration files validated; oxlint passed; UI policy passed; 149 UI/interaction-policy tests passed. Acceptance includes migration concurrency/replay and preserved legacy history without privilege backfill, cross-owner/workspace/group/Artifact boundaries, suspended/removed members, revoked/regranted grants, spoofed authors, cross-group mentions/replies, duplicate/concurrent sends and dispatches, rollback/retry, bound reply deduplication, cancellation, late writes, actual lock-wait races (including a stop committing during reply validation), concurrent immutable revisions, exact human acceptance and stale/orphaned anchors.

Typecheck: 23 diagnostics on the exact base and the identical 23 diagnostics after this change; zero added diagnostics. The supplied dependency tree lacks posthog-js, happy-dom, chat/@chat-adapter packages, @heroui/react and @internationalized/date; related inferred-any diagnostics also appear on base. Full build/browser/real mailbox acceptance was not claimed. The new test is included in `test:groups` so existing disposable CI service runs it.


## Follow-up while awaiting reviewed mailbox source

The parent is preparing an internal same-owner source packet for mailbox head `2db17f7fd47c35771d8633d0b0ad488effd4cf31`; integration is pending that handoff, not permanently blocked. The original backend candidate `ab944bbd1a747ccd83411f093d174ef29349a449` remains preserved. Next acceptance will exercise actual app → durable dispatch → isolated mailbox worker → trusted reply/revision using the reviewed transport, fake native agents/providers and real Postgres, with no live models or new credentials.

Independent follow-up applied the real `scripts/migrate.mjs` runner from an empty PostgreSQL 17 installation to separate disposable `mikka_review` and `mikka_workspace_review` databases. All 28 migrations applied successfully. A second runner invocation applied zero migrations. Both runs used explicit loopback URLs for both database targets, never inherited user database configuration. The 32-test suite passed afterward; the subsequent runtime stop-race regression increased the total to 33 passing tests.

Runtime live validation now locks the dedicated run row through reply commit. A stop transaction already holding that row is observed after the wait and prevents reply/revision writes. The regression verifies an actual database lock wait and no persisted late reply. Lint remains clean and typecheck still matches the exact base's diagnostics.
