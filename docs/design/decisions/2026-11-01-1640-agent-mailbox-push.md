# Push incoming Agent mailbox notifications

- Date: 2026-11-01
- Source: Alex's handoff follow-up, relayed by the coordinator: incoming Agent mailbox messages must notify the recipient without depending on the Agent polling its inbox.
- Rule: —
- Replaces: the implementation's explicit-inbox-only delivery behavior; personal message authority and read/ACK rules remain in force.

A message committed to a running thread's personal mailbox sends a notification
through the device's existing commands long-poll. The notification contains
message IDs and tells the current Agent session to read its mailbox. Peer text
is fetched through the existing authenticated mailbox tool and retains its
server-set origin, source and reply route.

A notification is coordination data. It grants no user permission, changes no
tool policy and cannot answer a human decision. Notification delivery, inbox
read, message ACK and execution are separate states. Notifications retry until
the daemon acknowledges handing them to a live session. A stopped, expired,
disabled or terminal thread is never restarted by a mailbox notification.

Native Bot chats use their existing durable Coordinator event/wake path.
The server only sends the new device command to daemons advertising its
protocol capability, preserving existing input and stop delivery for older
versions.
