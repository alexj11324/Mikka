# Inbox API

Frontend consumers use this API for pending, snoozed and completed Agent / Inbox
items (#1820). Routes below are relative to the application's `/mikka` base path.
Authentication uses the existing session or workspace-scoped personal access token.
The requested workspace must have an active membership; a workspace token cannot
select a different workspace.

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
