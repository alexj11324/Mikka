# Personal mailbox server prerequisite

This local stack depends on the separately owned #373 transaction helpers and
the worker transport candidate. It does not replace either branch or include
enterprise audit, organization management, invitations, exports or retention.
The current rollout flag remains off; no configuration or database was changed.

The review SQL is not registered in Drizzle and must not be executed without
an approved environment, exact source, immutable input hashes and write budget.
It prepares one personal `session_mailboxes` table and its sequence; adds the
run's optional mailbox reference and message recipient/sender/idempotency/reply/
origin/ACK/failure/sequence fields; relaxes the old run-only message reference;
and adds lookup/deduplication indexes and foreign keys. It neither backfills
historical messages as human-approved nor creates a role or grants privileges.

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
An enabled deployment still requires the reviewed schema to be installed first.
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
