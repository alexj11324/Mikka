# Personal mailbox server prerequisite

This local stack depends on the separately owned #373 transaction helpers and
the worker transport candidate. It does not replace either branch or include
enterprise audit, organization management, invitations, exports or retention.
The current rollout flag remains off; no configuration or database was changed.

The schema is `drizzle/20261101020100_personal_mailbox_schema.sql`: one
personal `session_mailboxes` table and its sequence, the run's optional mailbox
reference, and the message recipient/sender/idempotency/reply/origin/ACK/
failure/sequence fields, in the shape production has had since 2026-10-25
(`workspaceId` text, `latestRunId` set null on run delete, `wakeBudget` 0–10,
`origin` default `owner`, `kind` includes `group`). `run_messages."runId"` is
nullable. It is a no-op on production and builds the same objects on an empty
database.

Dependencies already represented on main are `agent_runs`, `run_messages`,
`agents`, `devices`, `run_tokens`, `bots` and the three AgentKit version/head/
execution tables. A private Bot additionally needs the existing workspace
membership table and authority to hold its read lock through APP COMMIT.
The existing max-five APP and workspace pools are reused. Lock order remains
APP authorization parents/head, then workspace membership; no second APP
checkout is needed for scope checks inside an effect transaction.

New mailbox columns are deliberately absent from Drizzle's default selections.
Only rollout-gated personal mailbox SQL references them. Ordinary run, issue,
MCP report/ask/blocked and default AgentKit paths retain their old schema needs.
No production or retained test SQL, ACL change or new token is authorized here.

Frozen definitions select mailbox IDs explicitly. The current owner-selected
head can revoke them; neither a global flag, later definition nor peer text can
expand an old snapshot. The current catalogue must be supplied explicitly to
Coordinator tool registration. Claim capability and worker MCP tools derive from
the verified run, token, pinned worker snapshot, parent execution and current
grant. The server, not model arguments, selects all actor/namespace fields.

Both Bot and unbound personal Coordinator effects get APP cancellation custody;
the Bot additionally holds workspace membership. That custody is not a grant:
the same transaction must pass real owner/run/definition authority fences.
The existing store's bounded persisted infrastructure-retry family matching is
retained; independent senders are not joined merely because their UUID matches.
Unknown COMMIT remains unconfirmed and is never automatically replayed.

This is preparation for a separately reviewed server batch. Pure handler and
pool-model tests cannot establish genuine PG locking, cross-database revocation,
positive TLS or provider behavior. A new compiled Next/PG/MCP round needs a new
finite plan; previous R4 nonces, tokens and numeric remainder are not reusable.

New worker mailbox grants use capability version 2 and digest-bind the exact
host-derived Bot (including explicit null) and namespace at dispatch. Deleting
or rebinding a Bot cannot fall back to a personal mailbox before first use.
Legacy v1 or missing-scope grants keep normal worker execution but receive no
mailbox tools; stored historical definitions are never rewritten to grant them.
This changes no DDL. A future acceptance round must create newly frozen v2
workers rather than mutating retained v1 runs or reusing their old allowance.
