# Device details and Workspace activity

The settings backend exposes these read models for #2956 P8 and the settings
frontend in #2957. Types live in `lib/settings/device-activity-contract.ts`.
Every response uses `Cache-Control: private, no-store`.

## Device reads

`GET /api/devices/:deviceId/detail?workspaceId=WORKSPACE_ID` returns `device`,
`hardware`, `access`, `directories`, `scheduling`, `checkpoints`,
`cloudCheckpoints`, and `migration`. The caller must own the nonremoved device
and hold active membership in the selected Workspace. A different device owner
receives 404; an inaccessible Workspace receives 403.

Presence follows the existing gateway session columns. Hardware fields are
the daemon's persisted reports; an unreported field remains null. Scheduling
counts the same unfinished run states as the dispatch planner. Disabled or
offline devices have zero available slots. `access.canManage` describes the
existing local-device management surface; task-owned cloud machines retain
their thread lifecycle controls.

Directory bookmarks come from `device_project_checkouts`, filtered by the
selected Workspace, device owner and current content ACL. Their
`environmentIds` come from actual `workspace_project_environments` bindings.
An existing Project identifier is never relabelled as an Environment identifier.

The device detail returns both repository and cloud checkpoint lists. Each
contains at most 100 entries, newest first. Repository
entries expose the base commit, file count, capture time and recorded
availability. Cloud entries expose `snapshotState`, capture time and whether a
ready filesystem snapshot exists. Template identifiers, provider snapshot IDs,
checkpoint patches and credentials are not returned.

## Migration capability

Device detail reports `migration.available: false` and
`migration.reason: "machine_migration_not_supported"`. No migration mutation
is exposed.

The existing recovery paths can restore a repository checkpoint or recreate
the same task's provider machine from its own filesystem snapshot. They do
not provide a portable live-machine transfer to another device. Repository
patches do not preserve process memory, native sessions, ignored files or
credentials. Completing that infrastructure belongs in the existing thread
lifecycle work (#2936); P8 does not create a competing lifecycle writer.

## Contribution calendar

`GET /api/workspaces/:workspaceId/activity?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=member`
returns the UTC range, `contributions`, and thread-cost availability.
It uses the same date parser, default 30-day range and maximum 93-day range as
governance usage. `to` is inclusive in the request; `toExclusive` describes the
exclusive response boundary. The only calendar grouping is `member`.

The calendar requires an active Workspace administrator. It includes active
members and continues to apply task content ACLs. It returns counts, never
task titles, thread content or private PR URLs.

- Completed tasks use recorded transitions into `done`, once per task/day.
  Unchanged `done` snapshots do not count again.
- Merged PRs use the first recorded transition into `merged`, deduplicated by
  PR URL. The human assignee in that snapshot receives credit; without one,
  the recorded human actor or task owner does.
- Threads use the existing run-chain resolver. A retry or continuation does
  not count as a new thread.

`dateSource: "recorded_events"` distinguishes persisted Mikka event timestamps
from GitHub merge timestamps that the existing publication contract does not
record. Gaps between stored task revisions do not manufacture transitions.

## Thread costs

The calendar and existing governance usage response include:

```json
{
  "threadCosts": {
    "available": false,
    "reason": "thread_cost_ledger_pending",
    "items": null
  }
}
```

The complete per-thread model/machine ledger is owned by #2934. P8 does not
create a second ledger, infer subscription prices or turn unknown costs into
zero. Existing governance totals, grouping and CSV exports retain their
established semantics. This field must be connected to #2934's authoritative
reader after that contract is delivered.

## Validation and rollback

`tests/settings-device-activity.db.test.ts` exercises the HTTP handlers against
PG17, with only the authentication session replaced at the test boundary. It
covers owner/nonowner/Workspace/role denials, source and destination ownership,
current directory ACLs, safe checkpoint projection, failed migration behavior,
date boundaries and deduplicated contributions.

This work adds no database migration and writes no production data. A revert
of the API/read-model changes removes the added surface without undoing stored
device state or the existing usage ledger.
