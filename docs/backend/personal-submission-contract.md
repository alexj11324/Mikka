# Personal message submission retries

This change is limited to authenticated personal chat submissions. It uses the existing global unique `coordinator_events.dedupeKey` constraint; it adds no migration, permission, scheduler or approval mechanism.

## Frontend contract

- Coordinator HTTP: `POST /api/coordinator/messages` accepts `{text, submissionId?}`. Text is trimmed and must contain 1–10,000 characters. The optional submissionId must be a UUID; case normalizes to lowercase. Authentication supplies the owner. Caller-supplied owner, bot, question or approval fields are rejected with HTTP 400.
- Existing Bot-aware server action: `sendCoordinatorMessage(text, quote?, botId = null, submissionId?)`. The optional fourth argument enables the same retry contract. Existing authentication and `ownBot` checks run before event insertion, including on duplicate retries. `null` botId identifies the Coordinator. HTTP remains Coordinator-only.
- Keep one UUID and one frozen message/quote/chat body for an unsettled logical submission. Retry the same body with that UUID after an uncertain network/server outcome. An intentionally new message gets a new UUID, even when its text matches a previous message.
- HTTP returns the existing 202 `{queued:true, enabled}` shape on both a fresh write and an identical retry. A changed message under the same owner/chat/submission UUID returns 409 `{error:'submissionConflict'}`. The server action returns `{queued:true}` or its normal ActionResult with `error:'submissionConflict'`.
- Quotes participate through their existing serialized stored body. Changing quoted content/reference metadata under a settled UUID is a payload conflict. Separate Bot chats and different authenticated owners may independently use the same UUID.
- Calls without submissionId retain legacy independent-write behavior. The current main composer still omits the UUID; this backend change alone does not make that existing UI idempotent. Claude's frontend wiring must pass the fourth action argument or the documented HTTP body without changing layout.

### Durable frontend lifecycle

Persist one pending record before sending: `{ownerContext, conversationId, submissionId, text, quote, state}`. `conversationId` is null for the Coordinator or the actual Bot UUID returned by the authenticated Bot model, never a name/list position/agent ID. This record must survive retries and remount/reload using the frontend's existing account-scoped pending-storage mechanism; do not store credentials in it. The frozen quote includes artifact/version/kind/text/label/selector. The ownerContext is a local routing guard and is never sent as API authority.

1. On a new user intent, trim/validate the draft and allocate `crypto.randomUUID()` exactly once. Save its immutable body and actual chat, then invoke HTTP or the action. A second click on that pending item resends the same record.
2. Timeout, lost response, HTTP 5xx, or an unknown rejected server-action promise leaves the record pending. Retry its same UUID/body/chat; do not infer rejection or allocate a replacement UUID.
3. HTTP 401 or action `authRequired` suspends the record. After signing into the same account, retry it unchanged. Switching account must not replay another account's pending record; switching chat must not retarget its Bot ID.
4. HTTP 202 or action `{queued:true}` settles the record. The next intentionally new message gets a fresh UUID, including the same text sent again. Editing the current draft while another request is pending creates a separate user intent; it must not mutate the unsettled record.
5. HTTP 400/403 or action `messageRequired`/`validationGeneric` is a terminal validation/access failure for that frozen record. HTTP 409 or action `submissionConflict` is a terminal payload conflict. Surface the failure and stop automatic retry; do not silently change the body or generate a new UUID. A deliberate new message may get a new ID after that decision.

For HTTP send exactly `{text,submissionId}` to the Coordinator. For a Bot use `sendCoordinatorMessage(text, frozenQuote, actualBotId, submissionId)`. Do not strip a questionId from an old question submission merely to make it accepted: question/approval continuation remains outside this feature. Deduplication is durable while its event row is retained; no new retention/expiry policy is introduced.

## Deliberate boundary with #240 / #234

#240's older frontend also supplies optional `questionId`. That part of its contract is not implemented here. Such HTTP bodies are rejected, never stripped and treated as ordinary messages. No Factory question routing, approval/provenance conversion, Telegram handling or #234/#300 scheduling/resource integration is included. Existing wake callbacks remain in place for accepted attempts, including identical retries; the guarantee is one persistent event, not at-most-one wake callback.

## Storage and integration

`recordPersonalSubmission` hashes a canonical JSON tuple of authenticated owner, actual owned Bot ID (or null Coordinator), and normalized UUID into a bounded versioned key. INSERT ON CONFLICT DO NOTHING arbitrates writers. A losing writer reads the committed row and checks owner/chat/kind/issue/run/payload before accepting the retry. It never overwrites the original row or delivery state. SQL/read failures remain failures, not conflict success.

The shared `lib/coordinator/store.ts`, generic event factory/store, inbox handling and workflows are unchanged. #287's source/provenance changes must be preserved when combining candidates; this helper currently emits main's personal event shape and is not a substitute for another owner's provenance implementation.

## Validation limits

Thirteen pure tests invoke the store adapter and actual HTTP handler/server action with in-memory dependencies. They cover identical concurrent calls, changed payloads/quotes, owner/chat separation, uppercase UUIDs, Bot ownership including revocation, invalid input and DB-error propagation. They do not start Next, connect to PostgreSQL, run wake callbacks or call a provider.

Additional controlled contract tests hold an uncommitted winner's adapter result and assert no premature read or success, then release commit/rollback. Missing conflict rows and unknown SQL errors reject rather than report acceptance; HTTP/action calls without IDs stay compatible. These tests model the adapter boundary, not actual PostgreSQL lock/snapshot behavior. The implementation expects independent statements at READ COMMITTED against the same authoritative database; higher isolation or deleted conflict rows are error cases, not successful duplicates.

Actual PostgreSQL concurrent INSERT/conflict-read behavior, request-scoped database isolation and compiled HTTP acceptance remain to verify under a separately approved retained fixture. The previous run-message/stop fixture and its approvals are unrelated and must not be reused to authorize new event tables or writes.
