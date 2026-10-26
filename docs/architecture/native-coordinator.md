# Native Coordinator runtimes (issue #312)

## Ownership and execution

The default Coordinator is the existing AI SDK / WorkflowAgent implementation.
There is no Prime runtime. The optional choices are `claude_code` and `codex` on
one of the person's linked, enabled devices. Mikka still owns the conversation,
memory, event inbox, authorization, pending-action approvals and OpenUI renderer.
A native choice is the only conversational model in that turn, not a worker
behind a second persona model.

Claude uses a replacement string `systemPrompt`, no built-in coding tools, a
strict in-process Mikka MCP server, no local settings and no persisted session.
Codex uses `baseInstructions` and application `developerInstructions`, an isolated
CODEX_HOME, ephemeral threads, read-only execution and Mikka dynamic tools.
Dynamic tools require the experimental App Server API; the advertised minimum
is Codex 0.162.1. Native protocol changes must be tested before relaxing this gate.
Coding worker adapters and their preset/instruction/handoff behavior are unchanged.

## Event path

An existing user/event wake acquires the normal Coordinator lease. AI SDK remains
the default; an explicit native selection enqueues a short-lived device turn.
The daemon claims it once, creates a private context directory (not a worktree),
and starts the selected harness. Tool calls return to the same durable,
person-scoped Workflow tool callbacks. The first implementation uses a bounded
one-second durable Workflow poll, plus half-second daemon tool-result polling;
no model polls an inbox. This trades some transport latency for an inspectable
replay path without introducing a second orchestrator.

Replies and tool results are appended to the existing canonical conversation;
OpenUI source is passed through without a formatting model. Native sessions are
not resumed or copied between machines: every turn receives the host's current
memory, existing summary and conversation. A context above 500,000 characters
fails explicitly instead of dropping history or charging another model for a
hidden fallback. The default AI SDK compaction path is unchanged.

Jobs expire after three minutes; active harness work is capped at two minutes.
Failures, login problems, offline devices and protocol incompatibilities never
switch to another model automatically. Shutdown/sign-out aborts the native run.
The job payload is cleared when the Workflow closes it. Tool receipts stay in
the application database with the existing conversation's data boundary.

## Permissions and rollout

Apply `20261026170000_native_coordinator.sql` to an approved non-production
branch first. Set `MIKKA_NATIVE_COORDINATOR=1` only in the environment being
validated, and restart a daemon built from this change. Older servers return no
job; older daemons do not advertise the `coordinator` harness capability.
Existing users are not migrated to a native model.

The owner-authenticated endpoint is `GET/PUT /api/coordinator/runtime`. PUT uses
same-origin protection and refuses changes while a Coordinator turn holds the
lease. Select, for example:

```json
{"harness":"claude_code","deviceId":"<owned-online-device-uuid>"}
```

or `{"harness":"codex","deviceId":"<owned-online-device-uuid>"}`. An optional
`model` uses the selected harness's native model identifier. Restore the default
with `{"harness":"ai_sdk"}`. This PR exposes the backend selection API; it does
not add a new settings picker or change an existing Bot's UI.

All device requests are checked against the owner, bound device, active lease,
job status and deadline. Tool names and JSON schemas come from the host, never
an email. Tool execution reuses current account approval behavior: an OpenUI
button is not consent to send email. Duplicate native call IDs reuse receipts;
changed arguments conflict. Admission is serialized and capped at 40 calls.
This does not claim universal exactly-once external side effects: existing tool
implementations must retain their own idempotency/approval guarantees.

## Validation

```sh
pnpm --filter @mikka/daemon typecheck
pnpm --filter @mikka/daemon test
pnpm typecheck
pnpm test:coordinator-native-relay
pnpm test:coordinator-native
# Database tests require an isolated localhost PostgreSQL database:
NATIVE_COORDINATOR_TEST_DATABASE_URL=postgresql://mikka_test@127.0.0.1:55432/mikka_native_test pnpm test:coordinator-native
```

Database tests create/drop only a randomly named schema and refuse non-localhost
or incorrectly named databases. They need no account/model credentials.
SDK subprocess and App Server protocol fixtures test real transport boundaries,
not real model quality or authenticated provider behavior. Complete live Claude
and Codex validation, current-model OpenUI quality and authenticated Preview
acceptance before enabling this optional backend in production. The implementation
does not claim to add new email subscriptions, dinner schedules, push delivery,
or a settings picker; it routes existing Coordinator events through the selected
runtime. No production migration, deployment or runtime switch is part of this PR.
