# Inbox production acceptance (#1820)

Use this guide to run and recover the issue 1820 production acceptance as its
release operator. The driver is `scripts/acceptance/inbox-production.mjs`. It uses the existing
`self-hosted-production.yml` current-main `workflow_run` entry, the normal
shared smoke account, and owner HTTP APIs. Its credentials are still the two
named Infisical `prod:/` smoke secrets delivered by the existing OIDC identity.
No database access, provider credential export, synthetic webhook, model prompt,
GitHub permission grant, or new identity is part of this driver.

This file describes a runnable acceptance path, not a production pass receipt.
The production result remains incomplete until every coverage field and cleanup
check in `self-hosted-production-report/inbox.json` passes.

## Select the actual release before credentials

The offline guard tests run on this PR. A production attempt is selected only
when all of these facts agree:

- The current event is the successful, actual main Web deployment in the existing
  Core workflow; the public `/mikka/api/version` and current `main` agree.
- PR **1822**, from this repository's **feat/inbox-1820**, is merged and its
  `merge_commit_sha` is exactly that deployed source. The actual Git commit has
  two parents, and the second is the PR's current head. An unrelated later main
  publication, squash, other branch, fork, or open PR does not select the driver.
- Issue 1820 remains open. The normal Web deploy job and all its required
  publication/version steps succeeded for the same source.
- The latest Inbox marker in a comment by `alexj11324` on issue **1752** is active,
  bound to the same PR head and source, and lasts at most two hours. Its exact
  comment and marker digest are pinned for this attempt.

The operator still reads the latest release-window discussion and actual runtime
publishers before claiming a window. A machine-readable marker cannot replace
that coordination. Do not edit, release, or supersede the selected marker while
the attempt is making writes. A changed marker, newer own marker, expiry, changed
main, or deployment mismatch blocks the next business write. Own-session logout
remains available for cleanup.

The marker is one line inside the ordinary window comment. Replace every
placeholder with the actual public metadata; a placeholder never selects a run:

```text
<!-- mikka-inbox-1820 {"state":"active","issue":1820,"pr":1822,"branch":"feat/inbox-1820","headSha":"<40-hex PR head>","sourceSha":"<40-hex actual ordinary merge>","startsAt":"<UTC ISO time>","expiresAt":"<UTC ISO time, at most two hours later>","phase":"inventory"} -->
```

The existing queue remains `production-smoke-owner-acceptance`. The only new
GitHub permission is `pull-requests: read`, needed for the exact PR metadata.
The workflow has no new dispatch, write token scope, or Infisical binding.

## Inventory uses the real test account

The initial `inventory` phase signs in normally, verifies the account identity,
selects the account's existing team workspace, and remembers the prior selection.
It inventories all three Inbox tabs across accessible personal/team workspaces,
up to explicit bounds. It reads normal linked-account and GitHub integration
metadata, including already linked numeric GitHub IDs and whether the test
repository is already authorized. It neither connects a provider nor grants a
repository permission.

The existing owner-only GitHub integration response now includes the verified
public numeric `githubAccountId` already returned by its authorized discovery.
This adds no provider request or grant and exposes no token. Cloud connections
intentionally have a null login and may have no GitHub sign-in account; they can
therefore be inventoried without misreporting an existing binding as missing.

It also reads recent team tasks through normal owner APIs. Existing tasks and
suggestions remain unchanged. A Factory task with a PR must expose the cached
`flow.review.summary`, with branch, head, added/deleted lines, changed files, and
checks counts. A complete human handoff summary is read twice; unchanged revision
and digest establish a consistent persisted snapshot. A task without a PR must
return an empty review/summary through the successful flow route. Unknown counts
or checks stay unknown. The matching source and PostgreSQL tests establish that
these product reads do not make per-request GitHub API calls.

The report contains no email, password, cookie, session ID, raw account response,
private task title, or branch text. Its closed metadata includes the owner's
SHA-256 hash, personal workspace UUID, public GitHub numeric recipient IDs, and
`inventory.fixtureRequest`: a new nonce, source SHA, workflow run/attempt,
creation time, and six-hour upper lifetime for an exact disposable event.

Inventory alone exits **2**, with `completeAcceptance: false`. Missing fixtures,
missing complete summaries, or an actual API refusal must not be presented as
business acceptance passing. Capped discovery is explicitly marked incomplete;
it supplies coverage only for the individual required cases actually observed.
A repository that contains no fixture
definition does not prove the production account lacks an existing connection.

## Produce one real disposable GitHub event

Use only the existing authorized `alexj11324/Mikka-handoff` repository and the
numeric GitHub identity actually linked to the smoke account. Do not borrow an
unrelated identity or expand a shared installation. The normal verified GitHub
webhook is the producer; there is no owner API that inserts an arbitrary suggestion.

Copy the exact closed `inventory.fixtureRequest` into the fixture declaration and
append `github` with the actual repository, issue number, event/comment numeric
ID, kind, recipient ID, and actor ID. Use one of these normal events:

| Kind | Required independent source proof |
| --- | --- |
| `issue_comment` | A newly created issue/PR owned by the linked recipient, containing `<!-- mikka-inbox-1820:<nonce> -->`; a new comment with the same marker, by the declared actor, on that exact issue. The driver verifies the exact comment URL and numeric ID. |
| `assigned` | A newly created issue/PR by the declared actor, containing the nonce marker, assigned to the linked recipient; the exact assignment event must name the same issue, actor, and assignee. |

The declaration has this shape (all identifiers shown are placeholders):

```json
{
  "schema": 1,
  "purpose": "mikka1820-owner-github-fixture",
  "nonce": "<UUID from inventory>",
  "applicationSha": "<same deployed source SHA>",
  "inventoryRunId": 123,
  "inventoryRunAttempt": 1,
  "ownerHash": "<owner SHA-256 from inventory>",
  "workspaceId": "<personal workspace UUID from inventory>",
  "createdAt": "<inventory creation time>",
  "expiresAt": "<inventory expiry time>",
  "github": {
    "repository": "alexj11324/Mikka-handoff",
    "issueNumber": 123,
    "eventId": 456,
    "kind": "issue_comment",
    "recipientId": "123456",
    "actorId": "654321"
  }
}
```

Decision scoring, source switches, quotas, and the existing internal model path
still control whether a normal webhook produces a visible suggestion. Do not
send ad hoc API-key prompts, replay fabricated webhooks, or keep creating events
until one happens to pass. An absent card is an observed missing fixture, not
proof of a particular billing or model failure. Diagnose the normal producer and
its existing receipts before another attempt.

Once the real source event has been delivered, close this newly created test
issue/PR through the normal GitHub owner operation. The driver requires it to be
closed and verifies that the event occurred between its creation and closure.
Closing before the notification has actually been produced can affect the normal
producer; do not assume immediate delivery. Source timestamps are normalized for
GitHub's second precision and the application's ISO millisecond representation.

After the inventory attempt has ended and its session/workspace cleanup passed,
publish a new bounded own marker with the same exact head/source, `phase: "fixture"`,
and the closed `fixture` object above. Do not change the marker of a running attempt.
If the existing GitHub connector's normal Actions write permission allows it,
rerun only the failed production job; this capability must be verified by the
actual call. It must remain the same workflow run/source, with the current attempt
at least the inventory attempt. No new dispatch or permission expansion is assumed.
The driver freshly verifies source, main, Web, PR, window, account, and source event
before it acts. Do not rerun already successful paid E2B acceptance paths.

## Business checks and cleanup

After proving the exact fixture, the driver reads `/api/suggestions` once to bind
the real URL, normalized occurrence time, action, required flag, and suggestion
UUID. This legacy GET can create the day's briefing, restore normal Composio
triggers, and wake the Coordinator. It is deliberately absent from inventory;
the driver rechecks the release authority before this call and reports the side
effects explicitly. It never chooses a card by title, nonce-like text, age,
position, or prefix. The Inbox row must belong to this owner and personal
workspace, be pending, and have no earlier completion history.

Before the first command, the driver writes a closed binding record to
`inbox-journal.jsonl` and `inbox-fixture.json`, then waits for the corresponding
`MIKKA_INBOX_BINDING_RECEIPT=` line to flush to standard output. The record binds
the source and suggestion UUID, owner hash, personal and original workspaces,
session ID hash, release marker digest, source revision, run, and attempt. It
contains no session token or cookie. This confirms local recording; a later
recovery independently checks that GitHub retained the original completed job's
log. The driver then checks:

1. Snooze, duplicate snooze, pending/snoozed readback, reopen, and duplicate reopen.
2. A short real due deadline: wait for both real live invalidation keys, then read
   once to establish expiry/reappearance. There is no HTTP polling fallback.
3. Reject, duplicate reject, one actor/time completion receipt, undo, duplicate
   undo, pending restoration, and retention of the original done receipt.
4. Cached Factory summary and no-PR behavior from the earlier normal task reads.

The live socket uses the exact owner/workspace channel and allowlisted official
gateway, validates the short-lived ticket, observes advertised capabilities, and
uses the ordinary ping/pong heartbeat. It never logs the ticket or protocol.

Finally, the driver reopens and rejects only its source-bound disposable UUID,
reads back absence from pending/snoozed and the retained owner receipt, closes
the socket, restores the original workspace, signs out, and proves the original
cookie no longer authenticates. It rereads the production version after cleanup.
Rejection consumes attention delivery state; undo cannot reconstruct arbitrary
historical state. This is why historical suggestions are never mutation fixtures.
Completion receipts are intentionally retained by the product; cleanup does not
delete audit history.

A withdrawn window blocks new business commands. The automatic closing path still
permits only the already journaled suggestion UUID's reopen/reject, the saved
original workspace restoration, and this attempt's session revocation. It cannot
snooze, accept, undo, switch to another workspace, or act on another item. A lost HTTP write
response uses only idempotent commands on the already journaled UUID. Any cleanup
refusal, missing coverage, unavailable source, changed deployment, or malformed
response prevents a pass. HTTP failures retain numeric status and an allowlisted
error-code projection, never arbitrary server bodies.

## Recover an interrupted attempt

Use `phase: "cleanup"` after a process interruption or failed automatic cleanup.
A normal fixture attempt cannot recover this state: suggestions may be hidden
by snooze/rejection, and retained completion history correctly prevents a second
business probe. Recovery uses the earlier exact binding and normal owner APIs.

1. Read the original completed Core acceptance job's log and locate its single
   `MIKKA_INBOX_BINDING_RECEIPT=` record whose journal state is
   `bound_before_mutation` or `recovery_bound_before_cleanup`. Retain its `sha256`,
   run ID, attempt, and job ID. Do not copy tokens, cookies, or other log lines.
2. Confirm that the original PR merge is still the deployed current main and
   issue 1820 remains open. Coordinate a fresh window on issue 1752. The recovery
   attempt must belong to the same workflow run and a later attempt.
3. Publish a new bounded marker with `phase: "cleanup"` and the exact recovery
   reference. Do not supply a fixture or edit a marker used by a running attempt.
4. Rerun only the diagnosed production job through the existing authorized
   Actions operation. Confirm the actual API call succeeds. Do not replay paid
   E2B acceptance or assume a dispatch capability.
5. Inspect the recovered suggestion's absence from pending/snoozed, retained
   owner completion, original session absence, restored workspace, current
   session sign-out, and closing production version before releasing the window.

Use this one-line marker, replacing the uppercase placeholders with the actual
metadata. Run, attempt, and job IDs are JSON numbers; the SHA fields are hex
strings, and timestamps are UTC ISO strings:

```text
<!-- mikka-inbox-1820 {"state":"active","issue":1820,"pr":1822,"branch":"feat/inbox-1820","headSha":"PR_HEAD_SHA","sourceSha":"MERGE_SHA","startsAt":"START_UTC","expiresAt":"EXPIRY_UTC","phase":"cleanup","recovery":{"schema":1,"purpose":"mikka1820-journal-recovery","runId":ORIGINAL_RUN_ID,"attempt":ORIGINAL_ATTEMPT,"jobId":ORIGINAL_JOB_ID,"journalSha256":"ORIGINAL_BINDING_SHA256"}} -->
```

The driver uses existing `actions: read` permission to verify the original run
attempt, its complete attempt-specific job listing, the exact job's
`run_attempt`/run/source/workflow identity, and the actual plain-text job log.
The repository token is not sent to the temporary log download host. The pinned
record must be canonical and unique; conflicting or malformed binding records
refuse recovery. Downloaded logs and signed URLs remain in memory and are not
written into the receipt.

After sign-in, the owner hash, personal workspace, saved workspace choices, and
exact suggestion UUID must match. Pending, snoozed, and already rejected states
are supported; a missing object or changed scope fails closed. Recovery does
not read `/api/suggestions`, wake the producer, create a fixture, run live
business checks, or select a historical card by a prefix or timestamp. It writes
a fresh recovery binding before any cleanup write. After that binding, the
exact cleanup can finish even if the fresh window expires or is withdrawn.

Only the bound suggestion's `reopen`/`reject` operations and saved workspace
restoration are permitted. Original sessions are matched by their recorded ID
hash in the authenticated owner's normal session list, excluding the current
recovery session. Their tokens stay in memory for `revoke-session`; a second
owner list must prove absence. An already absent original session is recorded
as absent. A recovery interruption can retain up to eight precisely journaled
prior session hashes; there is no bulk session revocation or age-based search.
The recovery session itself is always signed out and its original cookie tested.

Successful cleanup reports `status: "cleanup_passed"`,
`completeAcceptance: false`, and **exit code 2** because business acceptance
remains incomplete. It never closes the issue or credits missing coverage.
Missing original logs or an absent binding record remain explicit blockers to
this automatic recovery path; creating another fixture does not clean them.
An interruption before a binding record exists cannot be reconstructed by this
driver. No suggestion command is sent before that record, but any unproven
earlier session requires independent exact evidence for normal owner cleanup.

## Verification and retained files

Run the exact workflow offline guard command:

```sh
node --import tsx --test scripts/acceptance/self-hosted-production.test.mjs scripts/ops/production-mobile-daemon.test.mjs scripts/acceptance/inbox-production.test.mjs scripts/acceptance/inbox-production-target.test.mjs scripts/acceptance/inbox-production-recovery.test.mjs
```

Tests exercise forged/expired/changed selection, no credentials before selection,
normal owner inventory, exact external source and recipient binding, live deadline
delivery, duplicate commands/receipts, lost responses, failed durable journaling,
window withdrawal, logout, changed production builds, heartbeat, original job-log
provenance, recovery from all three Inbox states, precise prior-session revocation,
and closed-output canaries. They do not substitute for the production API receipt.

The workflow retains `attestation.json`, `inbox-selection.json`, `inbox.json`, and,
after exact binding, `inbox-fixture.json` and `inbox-journal.jsonl`. Closed results
are also printed to the job summary/log. Artifact upload and log retention must
be checked separately; a local write does not prove either remote copy exists. Record the
actual main merge, served version, current-head CI, production workflow run/attempt,
automatic E2B/R7 terminal outcomes, cleanup result, and release-window release in
issue 1820 before closing it.
