# Inbox API

Frontend consumers use this API for pending, snoozed and completed Agent / Inbox
items (#1820). Routes below are relative to the application's `/mikka` base path.
Authentication uses the existing session or workspace-scoped personal access token.
The requested workspace must have an active membership; a workspace token cannot
select a different workspace.
Task visibility uses the task's canonical `workspaceId` with
`ownershipState=bound`. Team links and legacy `scope` do not grant access.
Personal workspaces remain visible only to their owner, even if an invalid
membership row exists.
Reads and commands preserve the original authenticated reader through
`withTaskWorkspace`; workspace admission and Enterprise session/token policy
remain at that shared boundary.

## Read items

`GET /api/inbox?workspaceId=<uuid>&tab=pending&limit=50`

- `tab`: `pending` (default), `snoozed`, or `done`.
- `limit`: integer 1–100 (default 50).
- `cursor`: opaque `nextCursor` from the previous response for the same tab/workspace.

```json
{
  "items": [{
    "id": "c14bb489-b55c-4c78-935f-4288f65d81c0",
    "type": "suggestion",
    "source": "gmail",
    "title": "Reply to the proposal",
    "issueId": null,
    "runId": null,
    "ownerId": "user-id",
    "reason": null,
    "pending": true,
    "status": "pending",
    "snoozedUntil": null,
    "rejectedAt": null,
    "rejectedBy": null,
    "canReply": false,
    "actions": ["accept", "reject", "snooze"]
  }],
  "nextCursor": null,
  "historySince": "2026-11-09T13:00:00.000Z",
  "historyBackfilled": false,
  "live": { "workspaceId": "workspace-uuid", "keys": ["issue_list", "pending_actions", "thread_list", "task_run_list", "bot_chat_list", "bot_chat", "factory_task"] }
}
```

`historySince` is the actual time the migration ran, not the example above.
History starts at that instant; earlier handling is not backfilled.

`type` is `task` or `suggestion`. A task's `id` and `issueId` are its task UUID;
`runId` identifies its latest attempt. Suggestions use their existing suggestion
UUID. Task `source` is `agent`; suggestion `source` is its connected app. Task
`reason` is `needsReply`, `confirm`, or `review`; suggestion `reason` is null.
`pending` describes the underlying source; `status` describes this tab's item.
Timestamps are UTC ISO 8601 strings. Nullable fields remain present as null.

A done item additionally contains:

```json
{"completion":{"id":"receipt-uuid","action":"answered","actorId":"user-id","at":"2026-11-09T13:05:00.000Z","runId":"attempt-uuid"}}
```

Completion actions are `answered`, `approved`, `merged`, `accepted`, and
`rejected`. Each receipt remains after undoing a rejection. Multiple handling
actions can refer to one task; use `completion.id` as the done row's React key.
History follows current source access: removing workspace membership or deleting
the source removes its visibility. A teammate can read a shared task's receipts,
but cannot read another user's suggestions or acquire thread execution rights.
Only Mikka merges with a known human actor are attributed; GitHub webhook-only
merges do not infer an actor from task ownership.

## Render available actions

Render only actions present in `actions`:

| Action | Operation |
| --- | --- |
| `open` | Open `issueId` using existing task navigation. |
| `reply` | Use the existing thread reply flow for `runId`; only its owner receives this action. |
| `accept` | Call existing `sendSuggestion(id)`; its existing idempotent submission contract is unchanged. |
| `reject` | POST the command below. Only suggestion owners receive it. |
| `undo_reject` | POST the command below from the done tab. |
| `snooze` | POST with an absolute future time. |
| `reopen` | POST to cancel the current user's snooze. |

Review/approval execution keeps the existing detail-page authorization and
candidate/revision checks. `open` does not grant approval authority.

## Read a Factory approval summary

Use the existing human-session `GET /api/factory/tasks/:taskId/flow` route and
read `review.summary`. The route keeps its canonical task, Bot, owner and
selected-workspace authorization. The summary contains:

```json
{
  "branch": "mikka/mik-42",
  "additions": 28,
  "deletions": 4,
  "changedFiles": 3,
  "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "checks": { "passed": 12, "failed": 1, "pending": 2, "skipped": 1 },
  "checksUpdatedAt": "2026-11-09T14:00:00.000Z"
}
```

There is no summary for a task without a delivered PR: `review` is null when
there is also no review, or `review.summary` is null when a review exists.
Each missing historical field is null. `checks` is null until a complete
snapshot for that PR head has been synchronized. An observed complete empty
snapshot has zero in each count. `skipped` includes GitHub's neutral and skipped
conclusions; neither is reported as a pass. Cancelled and timed-out checks count
as failed. This snapshot describes observed checks, not branch-protection
requirements or permission to merge.

The route reads the current candidate's persisted `run_publications` record;
it never requests GitHub. Publication ingestion resolves the PR details and
reads checks and commit statuses, with existing repository credentials and
permissions. After validating the original PR creation/list receipt, it makes
one optional detail read. A refused or unavailable detail read keeps the
verified publication, preserves fields already known, and leaves missing
counts and checks unknown. A detail response with a conflicting PR number,
repository, branch, task marker or head still fails; it cannot fall back to
older evidence. A checks refusal leaves `checks` null without failing publication.
The existing signature-verified webhook updates PR metadata and, when delivered
by the configured App, `check_run` and `status` events. Same-named jobs in
different check suites are counted independently; a rerun replaces only the
earlier result in its own suite. Duplicate and older events do not restore an earlier pass. A new PR
head clears the prior head's counts and checks. No App permission or subscription
is changed by this feature. `checksUpdatedAt` identifies the cached observation;
without check/status subscriptions it remains the publication snapshot until a
later ingestion. Factory live invalidations refresh an open approval view.

Snooze is personal to the viewer, within the selected workspace. It hides the
item from that viewer's pending tab; it never changes the task or hides work
from teammates. Snoozed suggestions are also hidden from the legacy suggestion
list and briefing highlights. Rejected suggestions stay dismissed, retain their
external-source deduplication key, and are excluded from Coordinator attention
handoff. Rejection also settles its current attention matter and consumes an
undelivered handoff; undo makes that rejected matter eligible again. Undo restores visibility under the source's existing seven-day window.

## Write commands

`POST /api/inbox` with JSON and a matching application `Origin`:

```json
{"workspaceId":"workspace-uuid","type":"suggestion","id":"suggestion-uuid","action":"reject"}
```

`action` accepts `reject`, `undo_reject`, `snooze`, and `reopen`. Rejection and
undo apply only to suggestions. Snooze additionally requires `until`, an ISO
8601 timestamp with a timezone, strictly in the future:

```json
{"workspaceId":"workspace-uuid","type":"task","id":"task-uuid","action":"snooze","until":"2030-01-01T09:00:00Z"}
```

Success is HTTP 200 with `{"changed":true}` for a transition and
`{"changed":false}` for an already-applied command. Concurrent duplicate
commands serialize; no duplicate receipt or source action is created. Snooze
retries must still carry a future time. Rejecting an accepted suggestion returns
409. Reopen and undo are safe no-ops when no snooze/rejection exists.

| HTTP status | Body/error |
| --- | --- |
| 200 | Read page or write result. |
| 401 | `{"error":"authRequired"}` |
| 403 | `workspaceAccessDenied` or `originNotAllowed`. |
| 404 | `inboxNotFound`: missing item or item outside this user's selected workspace/source authority. |
| 409 | `inboxConflict`: source is already handled. |
| 422 | `inboxInvalid`: invalid query, cursor, command, type, UUID, JSON, or snooze time. |

## Refresh on live changes

Subscribe through the existing live channel and `use-live-key.tsx`; invalidate
the inbox read on the returned keys. For workspace list keys, use the selected
workspace ID. Existing thread, bot-chat and Factory subscriptions continue to
invalidate source state changes. Reject, undo, snooze and deadline expiry push
`issue_list` and `pending_actions` for the selected viewer/workspace. Accept
registers the same invalidation after the actual submission commits.

Deadlines reuse the existing `schedules` due timer. Its next time is the minimum
of schedule work and inbox snoozes; a committed snooze arms that timer. At the
deadline, an atomic expiry removes the snooze and pushes the existing live
invalidation. The existing slow schedules reconciliation recovers lost timer
starts. No frontend or backend polling is added.

## Verify

Use matching isolated loopback `*_e2e` URLs in `E2E_DATABASE_URL`,
`MIKKA_DATABASE_URL`, and `DATABASE_URL`, then run:

```sh
pnpm test:e2e:setup
REQUIRE_DB=1 pnpm test:inbox-db
```

The real PostgreSQL suite covers cross-workspace rejection, active membership,
thread-owner actions, simultaneous rejection, undo, manual reopen, precise due
times and live invalidation callbacks, transactional source receipts, pagination
at equal microsecond timestamps, and HTTP validation. CI enrolls it as a
mandatory database suite. These local checks do not establish production
acceptance; deployment and shared-account evidence belong on #1820.

`pnpm test:run-publication` verifies metadata ingestion, pagination, check-state
classification and unknown results. With the same isolated database URLs,
`REQUIRE_DB=1 pnpm test:run-publication-db` verifies concurrent webhook updates,
idempotence, repository/head binding, newer reruns and empty Factory summaries.
