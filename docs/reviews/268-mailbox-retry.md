# Mailbox retry operation identity

Base: frozen integration #268, a3294781eae74d824087c9c80bfc3f6093f196d7.

`retryNote()` describes infrastructure recovery as continuing previous work and explicitly prohibits repeating an already sent message. `mailbox_send.key` is a stable key for retrying the exact envelope. The previous `(senderMailboxId, dedupeKey)` check alone did not enforce this when `reclaimLostRun()` created a fresh attempt/mailbox.

The operation identity is now the authenticated owner's/workspace's server-persisted retry family plus the existing UUID key. Mailbox addresses, inbox rows, actual sender provenance and grants do not move. Only validated `retryOf` edges from failed/device_lost predecessors with consecutive attempts, matching owner/Agent/issue/kind participate. Existing shared-mailbox continuations remain one sender; a separate mailbox is never merged merely because it names a continuation or the same Agent. The mailbox's initial run canonicalizes the advisory lock across continuation/retry combinations. After locking, the family is read again before checking prior envelopes, including siblings that appeared while waiting.

All new-version senders serialize the logical key. Matching prior content/recipient/reply reference returns its existing receipt; changed payload returns 409. Existing multiple historical receipts return an explicit reconciliation-required 409. No rows are deleted and no effects are undone. Reply references can target inboxes in the validated retry family, but must still have come from the specified recipient. Disabled family mailboxes fail closed. The current attempt remains subject to the existing HTTP token/issue checks and store owner/device/live/stop checks; the logical scope cannot grant authority or resurrect an old token.

This is not universal exactly-once messaging: new keys denote new operations, ACK is not proof of downstream execution, and external effects require their own ledger. Existing multi-row duplicates require investigation. Deploy all mailbox writers at one compatible version; an old writer using only physical sender locks can bypass this protection. No schema migration or data repair is introduced.

Validation uses retained disposable PostgreSQL17 schemas, concurrent sends, same-role independent senders, continuation retries, conflicting payloads, historical duplicate ambiguity, workspace/disabled/stop fences, and the shipped MCP stdio subprocess. The MCP test commits an envelope then drops the HTTP socket, restarts the process and creates an infrastructure retry before replay. It also checks old-token denial and independent-sender same-UUID delivery. Its HTTP server calls the actual store and worker-token verifier; it does not substitute for full Next issue-policy, live vendor or production acceptance.

Frontend, group executors and #249/#250 are unchanged. No providers, deployment, production SQL, IAM or credentials are used. Original issues remain open pending the coordinated production acceptance.

## Independent completion/send lock correction

A separate real PostgreSQL17 barrier test pauses ownerSend after locking target M, lets complete lock its run and upsert coordinator C, then releases ownerSend. Before the fix, PostgreSQL detects 40P01: completion's result references M with KEY SHARE while ownerSend's sender FK references C. One transaction aborts. This is a pre-existing store defect, not introduced by retry identity.

The recipient lock is now FOR NO KEY UPDATE. It remains exclusive against other row writers, preserving scheduling serialization, but is compatible with the FK KEY SHARE needed by completion. The identical barrier now commits both envelopes and the succeeded run. No FK, authorization check or message is removed; no automatic retry masks the failure. The raw before/after logs remain in the private task evidence directory. Production acceptance is still pending.
