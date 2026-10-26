# #177 remaining approved writes

Base main: 2203c2c (2026-10-26), independent of the old #258 stack. This adds backend interfaces, not enabled product tools. Coordinator hot files and existing approval UI are unchanged.

## Contract for the Coordinator/approval owner

`createApprovedWriteTools(propose)` exports three proposal-only AI tools. The host must allocate/persist a UUID intentId for each logical tool slot and carry it across workflow/run retry. A regenerated prompt/tool call or runId must never allocate a replacement for an unresolved operation. User-explicit new intent gets a new UUID. Inputs do not contain owner, account or approval authority.

`approvedWriteHandler(realBetterAuth, action => createApprovedWrites(pool, provider, action))` supplies an unregistered POST handler. It validates browser cookie, exact Origin and fresh session; rejects bearer credentials. Propose body: `{op:'propose',action,input,intentId}`. Decide body: `{op:'decide',action,id,approve:boolean}`. Actor comes only from Better Auth. Codes: 200 result; 400 invalid operation/action; 401 missing/expired session; 403 Origin; 409 validation/binding/unavailable conflict. No worker/unattended approval.

The proposal uses the existing pending_actions table; execution uses the single #208 operation_ledger. Before approval UI registration, the host must expose an owned view of the exact stored input + pinned connection + target/context, and explicit confirm/decline. There is deliberately no live route or default registration here: existing UI cannot render these three action kinds yet. S owns Coordinator registration, stable slot propagation, execution events and original-chat result delivery. Frontend remains Claude's scope. These are concrete **integration blockers**, not completed end-to-end features.

Actions:
- append_notion_paragraph: `{page_id:UUID,text:1..2000}`. Exactly one literal paragraph appended; no arbitrary blocks, document replacement or deletion. Notion is selected because main already reads Notion. Google Docs remains a user choice, not another added provider.
- send_slack_message: `{channel:C/G ID,text:1..3000}`. Single existing channel, connected member only. No DM, thread creation, mentions, markdown or unfurls. Text is escaped for literal Slack rendering. This minimum does not add thread-target sends.
- cancel_calendar_event: `{event_id:1..1024,send_updates:'none'|'all'}`. Primary calendar only; notification choice is required and part of the approved payload.

The provider selects exactly one active connected account for the owner/toolkit, pins tool version and validates an exact target read. Only Notion UUID comparison ignores hyphens; opaque Calendar/Slack IDs are exact. Lack of write scope may still fail at the provider: read access is not proof of write permission. Authorization is rechecked at invoke and SDK pre-send hook. Pending decline/expiry fences before invocation; already invoked effects cannot be canceled by local decline. Connection changes, wrong owner/payload/action fail closed. Unknown errors/timeouts/401/429 after invocation stay running/unknown; they are not definitive failure. No automatic resend. Native lookup deliberately returns null; absence/current target fields are not evidence of a particular attempt.

## Reused foundation and migrations

main lacked #266's ledger. The ledger/session foundation originates from42ca56ebee733c9f5ed67bec0d48170e7506814e. Session authorization is unchanged; this follow-up adds a common transaction-scoped operation gate to the ledger and decision service. The two existing #208 SQL bodies are reused with new timestamps required by main's migration checker:
- 20261026135215_operation_ledger.sql
- 20261026135216_approved_write_binding.sql
They use IF NOT EXISTS and the same ledger/proposal columns, not a second approval ledger. Parent integration must deduplicate any later #266 foundation import. No production SQL was run.

## Provider and acceptance status

Composio adapter is implemented but **native tool argument/response schemas and permissions remain unverified on an authorized connection**. Tool names reference the existing Composio toolkit family: Notion append blocks, Slack send/conversation info, Google Calendar delete/get. Official catalogs: https://docs.composio.dev/toolkits/notion and https://docs.composio.dev/toolkits/slack . A tool catalog is not a completed native contract test.

Local real PostgreSQL + Better Auth HTTP + loopback provider tests cover proposals/decisions, ten-way concurrency, same intent changed payload/action, lost response, fresh service recovery, null/positive synthetic lookup, owner/account/expiry/decline/session fences. Adapter tests mock Composio; do not count them as real-provider acceptance. Schemas and synthetic sessions are retained (DELETE retention rule installed before auth tests). No real external write, credential configuration or real data deletion.

Still blocked: host stable intent/approval/event integration, user choice of controlled Notion page/Slack channel/Calendar event and exact connection/scope/notification side-effect package, native schema validation, real provider readback, screenshots/video and production acceptance. No issue closure or exactly-once claim.

## Follow-up narrowing: channel classification and cancellation snapshot

Slack requires explicit boolean `is_im=false`, `is_mpim=false`, membership and non-archived state; missing/malformed classification fails closed. Accept modern channels or legacy private G channels with consistent `is_channel/is_group/is_private`. Re-read the channel immediately before send and again after SDK preflight; bind the classification snapshot in the proposal contextDigest. The documented G-prefix MPIM case is rejected. Sources: https://docs.slack.dev/reference/objects/conversation-object/ and https://docs.slack.dev/reference/objects/mpim-object/ .

Calendar now accepts only confirmed/default organizer-self standalone events: reject any recurrence, recurringEventId or originalStartTime, hidden attendees, additional/async guests, missing ETag/organizer/timing or malformed metadata. Approved context includes strong ETag, exact event ID, organizer, summary, start/end, attendees and explicit none/all notification policy, with contextDigest in the proposal/ledger approval binding. Execution re-reads and compares it. Email identity does not prove a recipient is not a group address; future real acceptance must authorize those actual addresses.

Re-reading alone cannot close the read/delete race. Google documents conditional delete using the If-Match header and412 on stale versions: https://developers.google.com/workspace/calendar/api/guides/version-resources . The default native Calendar adapter therefore refuses deletion: no verified Composio conditional-delete support exists. An explicit trusted ConditionalCalendarDelete transport must atomically send the approved ETag in If-Match, use exactly the approved primary event and notification policy, honor cancellation, recheck authority immediately before send, perform no retries, and return the actual HTTP status. Only204 is accepted as confirmation;412/lost response stays unresolved with no resend. Loopback tests verify that contract, not a real Google/Composio deletion. Do not invent an if_match JSON argument. Sources: https://developers.google.com/workspace/calendar/api/v3/reference/events and https://developers.google.com/workspace/calendar/api/v3/reference/events/delete .

Slack catalog confirms SLACK_RETRIEVE_CONVERSATION_INFORMATION, version20261020_00; see docs/provider-contracts/slack-catalog-20261026.json. A single unauthenticated versioned metadata GET returned401. No credentials were read/configured to bypass it. This is not a verified parameter fixture. Native Slack now also defaults closed until the host supplies an independently reviewed exact-version raw-metadata SHA256 contract; schema drift, empty/latest version or missing contract blocks reads/sends. Tests use explicitly synthetic metadata contracts and assert requested slug/arguments; they do not validate actual native request encoding against a real tool schema. That remaining native encoding/schema test is BLOCKED, not passed.

Old proposals without contextDigest cannot execute; owned, uninvoked pending/running proposals can still be declined. Already-invoked proposals cannot be falsely canceled. No new migration; no product registration or S hot-file edit in this follow-up.

The common advisory transaction gate is acquired before ledger/session/proposal locks, including when the ledger row does not exist. It serializes decline with reserve/claim/invoke without holding extra pooled connections. The deterministic PG race test pauses decline after an empty ledger query, observes the concurrent approval waiting at the gate, then verifies decline wins with zero effects. A completed invocation cannot be subsequently reported declined.

## Intent UUID case correction

Propose validates intentId as a UUID and canonicalizes it to lowercase once, before the advisory key, SELECT and INSERT. Lookup also matches legacy uppercase UUID text without rewriting records. More than one existing case-equivalent owned proposal returns operationIntentAmbiguous, requiring explicit reconciliation; no automatic selection, deletion, new proposal or effect. This is an application invariant, not a new database uniqueness migration; raw SQL and mixed older writers are not covered. Keep registration disabled until all host writers use the corrected version. Tests cover serial and ten-way initial/retry case replay, valid payload and action conflicts (including concurrent first proposals), and unknown-result case replay with a single ledger/effect.
