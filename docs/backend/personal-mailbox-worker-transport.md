# Personal mailbox worker transport

This prerequisite wires the existing claimed-run MCP capability into the daemon's
actual Supervisor and CC/Codex adapters. It adds no database table, migration,
server tool registration, rollout configuration or owner grant.

`RunAssignment.mcp.mailbox` must be explicitly `true` in the authenticated claim.
Absent means no connection, mailbox instruction or tool. Current main does not
produce this flag; server storage and grant admission are a separate batch.
Never derive it from prompt text, peer messages or a process-wide enable flag.

`HttpServerLink.prepareRunMailbox(assignment, signal, check)` pins the MCP URL to
the daemon's configured server endpoint. It rejects alternate hosts, paths,
credentials, queries, fragments and insecure non-loopback HTTP. The bearer stays
in the host fetch closure; it is not put in child environment, files or CLI args.
Only the five locally defined mailbox names and strict argument schemas enter
the CLI. Remote descriptions, schemas and unrelated tools are not delegated.
The server remains responsible for owner/run/token and recipient authorization.

The Supervisor passes a host-created `RunMailbox` callback through existing
`StartOptions` to either local or hosted adapters. CC uses its in-process SDK MCP
control stream. Codex uses dynamic tools on the audited0.163.0 protocol, validates
thread/turn identity and refuses mailbox history resume or other CLI versions.
No socket mount, container egress, subscription credential or sandbox permission
is added. Existing native/provider feature gates are unchanged.

Each call checks held-run identity, nonterminal state, STOP and lease. STOP closes
transport before the CLI cancellation grace period; close aborts pending fetches.
401/403 permanently closes this run's capability. Unknown send outcomes return
an explicit uncertain result without automatic replay or a new idempotency key.
Queued, ACK and executed retain different meanings. Retry deduplication and
access checks require the separate server/storage implementation.

Run the retained, offline process fixtures from `packages/daemon`:
`node --import tsx --test test/run-mailbox.node-test.ts`.
They exercise the actual claim parser, Supervisor lifecycle and both adapter
process interfaces with fake vendor binaries and an injected fetch transport.
They use no database, Docker, external HTTP, login or model. Temporary fixture
directories are retained. Package type checks cover daemon and protocol.

This batch does not include #373's cancellation/transaction helpers, the separate
WS/APP checkout race repairs, or #352's already merged provenance wrappers.
It does not change AgentKit registry/defaults/frozen effectiveTools or hooks.
Enabling a real mailbox still requires reviewed storage, explicit owner-selected
frozen grants, current-grant revocation checks and a separately authorized bounded
PG/HTTP/MCP run. Fake process results are not vendor or production acceptance.
