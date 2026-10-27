# Personal message submission retries

This change is limited to authenticated personal chat submissions. It uses the existing global unique `coordinator_events.dedupeKey` constraint; it adds no migration, permission, scheduler or approval mechanism.

## Frontend contract

- Coordinator HTTP: `POST /api/coordinator/messages` accepts `{text, submissionId?}`. Text is trimmed and must contain 1–10,000 characters. The optional submissionId must be a UUID; case normalizes to lowercase. Authentication supplies the owner. Caller-supplied owner, bot, question or approval fields are rejected with HTTP 400.
- Existing Bot-aware server action: `sendCoordinatorMessage(text, quote?, botId = null, submissionId?)`. The optional fourth argument enables the same retry contract. Existing authentication and `ownBot` checks run before event insertion, including on duplicate retries. `null` botId identifies the Coordinator. HTTP remains Coordinator-only.
- Keep one UUID and one frozen message/quote/chat body for an unsettled logical submission. Retry the same body with that UUID after an uncertain network/server outcome. An intentionally new message gets a new UUID, even when its text matches a previous message.
- HTTP returns the existing 202 `{queued:true, enabled}` shape on both a fresh write and an identical retry. A changed message under the same owner/chat/submission UUID returns 409 `{error:'submissionConflict'}`. The server action returns `{queued:true}` or its normal ActionResult with `error:'submissionConflict'`.
- Quotes participate through their existing serialized stored body. Changing quoted content/reference metadata under a settled UUID is a payload conflict. Separate Bot chats and different authenticated owners may independently use the same UUID.
- Calls without submissionId retain legacy independent-write behavior. The current main composer still omits the UUID; this backend change alone does not make that existing UI idempotent. Claude's frontend wiring must pass the fourth action argument or the documented HTTP body without changing layout.

## Deliberate boundary with #240 / #234

#240's older frontend also supplies optional `questionId`. That part of its contract is not implemented here. Such HTTP bodies are rejected, never stripped and treated as ordinary messages. No Factory question routing, approval/provenance conversion, Telegram handling or #234/#300 scheduling/resource integration is included. Existing wake callbacks remain in place for accepted attempts, including identical retries; the guarantee is one persistent event, not at-most-one wake callback.

## Storage and integration

`recordPersonalSubmission` hashes a canonical JSON tuple of authenticated owner, actual owned Bot ID (or null Coordinator), and normalized UUID into a bounded versioned key. INSERT ON CONFLICT DO NOTHING arbitrates writers. A losing writer reads the committed row and checks owner/chat/kind/issue/run/payload before accepting the retry. It never overwrites the original row or delivery state. SQL/read failures remain failures, not conflict success.

The shared `lib/coordinator/store.ts`, generic event factory/store, inbox handling and workflows are unchanged. #287's source/provenance changes must be preserved when combining candidates; this helper currently emits main's personal event shape and is not a substitute for another owner's provenance implementation.

## Validation limits

Eight pure tests invoke the store adapter and actual HTTP handler/server action with in-memory dependencies. They cover identical concurrent calls, changed payloads/quotes, owner/chat separation, uppercase UUIDs, Bot ownership including revocation, invalid input and DB-error propagation. They do not start Next, connect to PostgreSQL, run wake callbacks or call a provider.

Actual PostgreSQL concurrent INSERT/conflict-read behavior, request-scoped database isolation and compiled HTTP acceptance remain to verify under a separately approved retained fixture. The previous run-message/stop fixture and its approvals are unrelated and must not be reused to authorize new event tables or writes.
