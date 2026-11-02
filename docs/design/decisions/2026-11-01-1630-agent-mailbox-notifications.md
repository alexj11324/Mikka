# Agent mailbox delivery notifies its receiver

- Date: 2026-11-01
- Source: Alex, Codex takeover: 「这个东西如果说是主动调用的话，是不是不合适啊？应该他能够收到提醒才对啊」
- Rule: —
- Replaces: the personal mailbox core's explicit-inbox-pull-only notification behavior

New incoming personal mailbox envelopes notify a running Agent at a safe boundary,
and wake an idle Bot so it can read its inbox. A stopped worker task keeps unread
mail and is never resumed by delivery. A notification carries an envelope ID,
not user authority; the receiver reads the original peer envelope with
`mailbox_inbox` and acknowledges it with `mailbox_ack` after handling.

The persisted envelope/event is the durable notification outbox. Delivery is
deduplicated by message ID, and the existing per-chat lease coalesces concurrent
arrivals. Reading, ACK and sent-status queries produce no new notifications.
Bots must not reply merely to ACKs, receipts or notification-only messages.

The host also limits an automatic peer-triggered notification chain to eight
hops. Its depth comes from the consumed event batch or the running thread's
incoming mailbox records, never a model-supplied key or `replyTo`. Mail at the
limit remains stored and unread without another automatic wake. A new
authenticated user input starts a fresh root; forwarded peer text cannot do so.

Mailbox delivery and its versioned-definition runtime are enabled by default,
with explicit operator kill switches. New definitions include mailbox tools;
existing definitions and frozen executions retain their exact grants. Current
head revocation still restricts a frozen grant. Peer content remains untrusted
coordination data and cannot authorize new work or external effects.
