# Durable account-action references across Coordinator and worker retries

Integration base: frozen #224 `4a1a31a502ccdab6aeb835f02ae18cb7dcc5d13b`
plus #227 `98f7b8cdaa9e63327d7039056d53391bddcaba98` (which includes #220).
Those candidate branches remain unchanged. This branch changes no publication ledger.

## Actual paths

The authenticated Coordinator POST accepts optional `submissionId` UUID. The server
returns `sourceEventId` and `replayed`. Same owner/submission/body reuses the event;
changed text or question reference conflicts. Existing clients without submissionId
remain supported but do NOT obtain transport retry deduplication. Claude must retain
one ID across retries of one submit and create another for an intentional new submit.
The original humanSessionId attestation remains unchanged on a replay; it is not
refreshed into new approval authority. Neither UUID nor text grants permission.

The inbox binds one foreground event at a time, still carrying up to 49 background
events. Existing coordinator_events.accountActionBatch stores the structured Calendar
calls, server-generated actionSlotId values and batch fingerprint before any proposal
is materialized. Source ownership and current Coordinator lease are checked in SQL.
The actual AI tool wrapper receives SDK options.messages (including the current
assistant tool batch), not a prompt-parsed key. Calendar and dispatch wrappers share
a pre-dispatch barrier, so parallel dispatch cannot snapshot an incomplete same-batch
set. Other account actions retain their prior behavior and are not covered here.

Each pending_actions UUID remains operationId. Its intent key is the persisted source
plus slot, never runId+action or payload digest. Identical payloads in distinct slots
remain distinct, and same call identity with changed batch conflicts. Source/slot
binding is inserted with the proposal under the lease/source locks; authority is
checked again after asynchronous provider preparation. Execution still requires the
existing authenticated browser approval, with final pre-send authority checks.

A failed turn retains its source batch. A new workflow can take it even though the
inbox event was already delivered. Before generating another model response it
materializes saved proposals, returns their existing IDs and reconstructs paired
assistant/tool messages. It cannot append a newly generated Calendar batch to an
older workflow's nonempty batch. An empty batch can be transferred under the lease.
Completion closes the source batch in the conversation append transaction. These are
intent references and planning progress, not another execution status machine.

Factory dispatch snapshots owned refs in its existing transaction (original task
source plus a trusted current Coordinator source when applicable). Ref arrays carry
sourceEventId, actionSlotId, operationId and frozen proposalDigest. Device-loss retries
copy the array; question continuation copies the exact original run array. Work created
in a later, separate model batch is not retroactively granted to an already-dispatched
run. A subsequent authorized dispatch must bind its own references.

Claim returns the refs through RunAssignment. The existing daemon journal retains the
whole assignment across process restarts. All three real harness adapters pass the
existing run-token readback endpoint to the local stdio MCP tool. Its
resume_account_actions tool issues only GET to the application worker route, never
writes a handoff or finishes the run. It validates endpoint/path and refuses redirects.
The server revalidates the token, owner, current lease/status/stop flag and exact stored
reference before returning proposal/ledger status. Remote worker MCP offers the same
read-only tool. No human session is fabricated and no unattended approval is added.

## Validation and limits

Local actual application modules, PostgreSQL 17, HTTP and child process tests cover:
submission contention/conflicts, two identical intentional slots, changed-payload and
foreign-owner rejection, saved-batch recovery, SIGKILL after batch commit before
proposal, lease expiry during preflight with zero proposal insert, background delivery,
parallel dispatch-first barrier, run retry, journal restart, real stdio-to-HTTP
readback and token revocation. Nine propagation tests pass. Existing Calendar tests
(10), ledger/session/SIGKILL tests (13), acceptance-driver tests (3), and frozen
question/monitor PG regressions (23) are separately checked. Local test schemas and
records are retained. The three selected Factory suites support explicit retention
of schemas and temporary filesystem artifacts. An earlier local monitor-dispatch
run cleaned its synthetic temporary repository through its pre-existing finally
handler; the retention flag now covers that directory too. No database records
were deleted in these runs.

The test HTTP server invokes the real application worker GET route. SDK tool-call
messages are synthetic; this is not a real model or deployed Workflow scheduler test.
No Google/Composio write is made. Real CLI/provider, unique preproduction deployment,
production real-user flow and sanitized acceptance video remain unverified. Parent
coordinates the single integrated release; keep #208 open.

## Official provider contract audit (read-only)

Google's [create-events guide](https://developers.google.com/workspace/calendar/api/guides/create-events)
allows caller-generated event IDs for recovery. Its [insert reference](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
requires base32hex-compatible IDs unique per calendar and cautions that distributed
collision detection is not guaranteed at creation. [Events.get](https://developers.google.com/workspace/calendar/api/v3/reference/events/get)
reads a known ID from the selected calendar.

The official [Composio Google Calendar toolkit](https://docs.composio.dev/toolkits/googlecalendar)
(and its downloadable `.md` schema) documents extended_properties on CREATE_EVENT,
but no caller-supplied id/event_id parameter for that action. Therefore this candidate
does not pass a guessed Google ID argument through Composio. Metadata-property lookup
is a possible separate adapter contract, requiring pinned create/list/get schemas,
complete account/calendar/payload validation and ambiguous/missing result handling.
The current adapter lookup remains unsupported (`null`), not a successful readback.
No exactly-once claim is made. A concrete authorized test account/calendar, limits on
real event creation and separately approved cleanup are still prerequisites.

## CI follow-up checkpoint

On 768acc0, dedicated ledger/propagation/PG regressions and dispatch CI passed;
full CI strict/typecheck passed, but its parallel Factory suite returned PostgreSQL
42P01 during the pre-existing synthetic Better Auth sign-in fixture. This code can
mean missing relation or missing FROM-clause alias; the old log did not distinguish.
The isolated approval suite passed 14/14 locally both with and without the browser
CI environment variables. The suite now retains its schema/files under the explicit
retention flag; sign-out expires retained synthetic sessions instead of deleting them.
Factory test files run serially to avoid concurrent schema create/drop during auth
schema introspection. This is a fixture-isolation fix candidate, not a proven root
cause until exact-head full CI completes. No publication implementation is changed.

On c6e3304, full CI's production build and browser regressions passed, including
all Factory PostgreSQL tests; the 42P01 did not recur. Dedicated ledger/intent and
dispatch CI passed too. The remaining failure was the inherited daemon lease test:
its 300ms lease expired before an assertion after a fixed 600ms sleep. The test now
observes a real heartbeat renewal with a setup-safe lease, then drives the existing
watchdog at the lease boundary and one millisecond after it. It still checks the
actual device_lost stop and ownership recovery, without depending on CI scheduling.
The selected local test passed (one selected, 27 filtered tests not run); its schema
and temporary artifacts are retained. Production lease behavior is unchanged.
