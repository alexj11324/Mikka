# Approved account actions and the operation ledger

This increment extends the #208 Calendar-create path on frozen candidate #258
`12368c4051c2b051828f681f46b7ff1148372f96` to the two existing #204 approvals:
`send_email` and `update_calendar_event`. It does not add a sending capability,
new approval UI, unattended approval, Factory publication state or daemon changes.

## Persistent intent and approval

All three Coordinator tools persist their typed action slots before proposing.
A new workflow recovers the saved tool names, payloads and operation references;
it does not infer identity from a prompt, regenerated tool call or run ID.
Previously persisted slots without `action` remain Calendar-create slots. New
submission IDs still distinguish explicitly new requests, including equal text.

The same operation service pins owner/personal workspace, action, account, tool
version, payload digest and approved proposal ID. Email recipients and calendar
event targets are in the approved payload digest. Calendar update targets use an
ID digest so the legal 1024-character input does not overflow the ledger target;
receipt object IDs support that same maximum. Calendar update still reads the
existing event from the pinned account and stores its summary for the existing UI.

Existing unbound proposals cannot safely establish a cross-retry identity or
pinned account after the fact. They may be declined, but cannot execute. They
must be proposed again under a new explicit intent and approved again. Running
bound proposals remain visible for all three actions.

## Unknown outcomes

Approval takes the existing durable invocation fence and rechecks the actual
session and proposal immediately before the provider call and after SDK schema
preflight. Concurrent approvals and restarts read the same operation. Disconnect,
timeout, missing receipt and failed SQL writeback stay unknown; the ledger may
remain `executing`, while the Coordinator event is explicitly `uncertain` with
attention priority. No evidence means no resend and no failed/succeeded claim.
An uncertain event and a later confirmed terminal event have distinct dedupe keys.

The native adapters deliberately return no lookup evidence. Neither a missing
Gmail message nor an event's current fields prove a particular attempt did not
execute. This increment does not invent provider idempotency or exactly-once.
The official Composio tool documentation describes version-pinned execution, not
a send/update idempotency-key contract:
https://docs.composio.dev/docs/tools-direct/executing-tools
https://docs.composio.dev/toolkits/gmail

## Integration boundaries and verification

No migration is added: existing proposal binding, ledger and action-batch JSON
storage are reused. Only the JSON slot gains an optional action discriminator;
old candidates cannot recover new non-Calendar-create slots, so deploy this
backend as one version and do not roll back to a create-only worker while such
batches are open. Worker references and their read-only API are unchanged.

Local tests retain isolated schemas and use synthetic identities and a loopback
HTTP provider. They cover all three actual proposal/decision entrypoints,
concurrent approval, lost responses, SQL writeback failure, separate-process
recovery, revoked/expired sessions and approvals, old unbound proposals, mixed
batch recovery, and old slots. Native adapter tests verify pinned toolkit/version,
update context, pre-send recheck and missing receipts. Browser acceptance must be
reported separately with its exact candidate SHA and test transport overlay.

No real email or Calendar writes are authorized by this change. Real provider
and production acceptance remain open for the parent-owned integrated release;
CI and synthetic acceptance do not close #208.
