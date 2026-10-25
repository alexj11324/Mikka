# Scoped Agent exchange backend (#110 / MIK-15)

Candidate base: frozen PR #268 `a3294781eae74d824087c9c80bfc3f6093f196d7`, itself based on main `a1610e7`. No dependency on audit/mailbox composition #272, policy #264 or credential revoke #275. Those owners' branches remain unchanged. #155 supplied only storage; #221 explicitly excluded MIK-15. At intake, #110 had no assignee/comments and no corresponding implementation PR.

## Published contract

- `GET /api/conversations/:id/messages` retains `messages` and `work`, and adds canonical newest-first `items`. Each text item has `type: 'message'`; an exchange item is `{type:'agent_exchange',linkId,position,count,participants:[{id,name,avatar}]}`. `nextBefore` is exclusive over the combined timeline, `limit` 1–100. Positions/counts are decimal strings. One marker consumes one source position. Markers are not messages and never contribute to unread counts or lastMessage. Clients that render exchanges must use `items` and its shared cursor.
- `GET /api/conversation-links/:id/messages?before=<decimal>&limit=50` returns `{linkId,readOnly:true,participants,messages,nextBefore}`. Only explicit messages in this link's inclusive first/last interval are returned, newest-first. Messages whitelist `id,position,body,createdAt,authorId,senderName,senderAvatar`. No private instructions, run/session/mailbox IDs, credentials, mentions or cross-conversation reply IDs are returned.
- Agents currently have no avatar column. `avatar`/`senderAvatar` are explicitly `null`; the frontend may use its existing letter avatar. This backend does not invent or copy private image data.
- Both reads require an authenticated current source-conversation member and active workspace membership. A user never joins the `agent_dm`. Unknown/foreign/invalid/revoked links return 404. POST/PUT/PATCH to the linked messages route return Next's 405; ordinary group read/write/member APIs still reject `agent_dm` IDs.
- `DELETE /api/conversation-links/:id` is restricted to the source conversation's current owner, with the existing Origin/Host policy. It monotonically revokes the scope, retains all history, and is idempotent. It grants no private DM write capability.

## Explicit exchange producer

The existing device-authenticated `POST /v1/devices/:deviceId/group-reviews` accepts an additional JSON command:

```json
{"action":"exchange","runId":"<authenticated assigned run>","exchange":{"workId":"<assigned work>","triggerMessageId":"<original human trigger>","claimEpoch":1,"exchangeId":"<stable segment UUID>","messageId":"<stable message UUID>","toAgentId":"<other currently granted Agent>","body":"<explicit group-scoped exchange text>"}}
```

Sender, requester, source, workspace, grants, and membership epochs are derived from the persisted isolated group assignment. The current run/device/credential, lease/claim epoch and original human membership must remain valid. Both Agents require current source grants from still-active owners who still own them. It creates a fresh, dedicated `agent_dm` with exactly those two Agent members. Reuse the segment UUID to append a continuous exchange; use a new UUID for a separate segment. Retries of the same message UUID/content are deduplicated; changed payloads conflict. Source lock serializes append, member changes and revoke. Segment/message UUID locks serialize cross-source reuse.

This operation persists explicitly submitted exchange text. It does not forward a private mailbox transcript, invoke providers, wake a recipient, add a native CLI tool, or change the existing public group-turn routing. Automatic Agent-to-Agent execution and provider acceptance remain their existing executor owners' work. The backend endpoint can be consumed by an authorized scoped producer; arbitrary legacy private histories cannot be attached. No user-facing link-creation API is introduced.

## Invalidity and race behavior

Provenance is immutable. Read-time checks bind source and DM kinds/workspace, exact trigger/source/requester, requester and Agent membership epochs, both original grant IDs, the two DM members, explicit message receipts, range/count and DM position. A source-member removal immediately denies that member. Requester leave/rejoin or Agent revoke/regrant cannot revive the old scope. Workspace suspension denies while suspended. No unspecified TTL is imposed; expiry of the producer's claim prevents writes, and current authorization/revocation determines read availability.

Read/revoke and dedicated single-transaction exchange commands acquire application/source locks before borrowing a workspace connection. The workspace connection is opened lazily at the first membership check; same-transaction device checks and workspace-member SHARE locks remain enabled. Read/revoke requests hold workspace-member SHARE locks through their application transaction, and hold the source lock through materialization. A suspension/revoke that commits first denies the read; an admitted read may finish before a waiting revocation. No HTTP system can retract bytes already sent. This is not a distributed application/workspace database commit guarantee. The existing worker-authority wrapper supplies same-transaction device checks and workspace locks for the producer; this patch does not broaden generic authentication.

## Migration and verification

Only new `20261025202112_conversation_exchange_scopes.sql` is introduced: application `MIKKA_DATABASE_URL`, additive provenance/receipt tables/indexes and immutable-identity/revoke triggers. Existing migrations remain unchanged. No legacy DM/link is backfilled or newly shared. Rollout must apply the migration before enabling the new reader/writer version; the normal build migrator is unchanged. Production execution is not authorized by this task.

`pnpm test:agent-exchanges` requires a dedicated loopback PG database named `mikka_exchange`; all fixtures remain retained. `EXCHANGE_HTTP_ORIGIN=http://localhost:3110` reruns the matrix against an actual compiled Next server with synthetic Better Auth sessions and an isolated device token. Without it, tests invoke actual application handlers and PG directly. No real OAuth or provider credentials are used. The dedicated CI runs fresh tracked migrations, repeats migrations, types, full lint and production build including pinned Linux workers, then real Next HTTP. Legacy fixture-deleting CI suites and real OIDC credential access are excluded only on this candidate branch; the source policy/type job still runs. Other branches' workflows are unchanged.

Production deployment, real user/OAuth/provider acceptance, the Claude frontend and an immutable deployed Preview URL remain unexecuted. Keep the PR draft and #110 open. Parent coordinates any integration and authorized promotion.

## Resource-order review and regression

Independent review identified a P2 pool/source lock cycle in the first reader wrapper. Real PostgreSQL with two separate max5 pools and unchanged ten-second acquisition timeouts reproduced it on `fd688c6332a5781006f4528ba29ade4a2235c942`: one real writer held the source row, four real readers waited for it, a fifth reader waited for the app pool, and all five workspace slots were held by readers. Releasing the writer's adapter barrier made it wait for workspace; an actual reader failed after 10018ms. This was an availability failure, not a demonstrated data disclosure.

Workspace acquisition now happens after app/source acquisition for the new reader/revoke operation and single-transaction group exchange command. The existing dedicated worker authority uses the same lazy acquisition seam; its token/device guard and SHARE locks are unchanged. No lock or authorization check is removed, and no timeout/retry masks the cycle. `pnpm test:agent-exchange-pools` uses the actual handlers, PostgreSQL source locks and production pool sizes, with a deterministic adapter barrier. It covers five readers plus one writer, then a cohort mixing link-reader and device-worker authority wrappers, and verifies a revoked device remains denied. These are handler/PG tests, separate from the compiled Next HTTP matrix. The pre-existing multi-operation poll callback can span several application transactions; this change does not claim a distributed commit or a new global pool-order guarantee for every unrelated callback.

The earlier `22572fa` HTTP CI failure is retained: the test HTTP adapter omitted group `limit/before` parameters. `fd688c6` corrects the adapter without changing production pagination or its assertions. Pool-order remediation is a separate subsequent product fix and must be accepted at its own exact head.
