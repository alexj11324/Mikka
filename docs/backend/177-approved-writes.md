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

main lacked #266's ledger. ledger.ts and session-authorization.ts are reused verbatim from42ca56ebee733c9f5ed67bec0d48170e7506814e. The two existing #208 SQL bodies are reused with new timestamps required by main's migration checker:
- 20261026135215_operation_ledger.sql
- 20261026135216_approved_write_binding.sql
They use IF NOT EXISTS and the same ledger/proposal columns, not a second approval ledger. Parent integration must deduplicate any later #266 foundation import. No production SQL was run.

## Provider and acceptance status

Composio adapter is implemented but **native tool argument/response schemas and permissions remain unverified on an authorized connection**. Tool names reference the existing Composio toolkit family: Notion append blocks, Slack send/conversation info, Google Calendar delete/get. Official catalogs: https://docs.composio.dev/toolkits/notion and https://docs.composio.dev/toolkits/slack . A tool catalog is not a completed native contract test.

Local real PostgreSQL + Better Auth HTTP + loopback provider tests cover proposals/decisions, ten-way concurrency, same intent changed payload/action, lost response, fresh service recovery, null/positive synthetic lookup, owner/account/expiry/decline/session fences. Adapter tests mock Composio; do not count them as real-provider acceptance. Schemas and synthetic sessions are retained (DELETE retention rule installed before auth tests). No real external write, credential configuration or real data deletion.

Still blocked: host stable intent/approval/event integration, user choice of controlled Notion page/Slack channel/Calendar event and exact connection/scope/notification side-effect package, native schema validation, real provider readback, screenshots/video and production acceptance. No issue closure or exactly-once claim.
