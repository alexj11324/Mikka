# Workspace task labels

Issue [#2956](https://github.com/alexj11324/Mikka/issues/2956), P6. This is the
workspace's **task** label registry. Thread lifecycle labels remain owned by
[#2936](https://github.com/alexj11324/Mikka/issues/2936).

## Contract

Browser-safe types and the six existing task colors are exported from
`@mikka/protocol/task-labels`. A registry row contains `id`, `name` and `color`.
Names are trimmed, between 1 and 40 characters, and unique ignoring case within
their workspace. Colors remain `violet`, `blue`, `green`, `yellow`, `red`, `gray`.

| Method | Endpoint | Input | Result |
| --- | --- | --- | --- |
| GET | `/api/workspaces/:workspaceId/task-labels` | — | Registry view |
| POST | `/api/workspaces/:workspaceId/task-labels` | `{name,color}` | Registry view and `label` |
| GET | `/api/workspaces/:workspaceId/task-labels/:labelId` | — | `{workspaceId,source,canManage,label}` |
| PATCH | `/api/workspaces/:workspaceId/task-labels/:labelId` | Nonempty `{name?,color?}` | Registry view and `label` |
| DELETE | `/api/workspaces/:workspaceId/task-labels/:labelId` | — | Registry view and `deletedId` |
| POST | `/api/workspaces/:workspaceId/task-labels/:labelId/merge` | `{targetId}` | Registry view, `mergedId` and `targetId` |

The registry view is:

```json
{
  "workspaceId": "workspace-uuid",
  "source": "workspace",
  "canManage": true,
  "labels": [{ "id": "label-uuid", "name": "Bug", "color": "red" }]
}
```

`source` is always `workspace`: label entities have no personal override or
default fallback. `canManage` reflects the freshly checked workspace role.
The view includes unused labels, so a label can be selected before any task
uses it. It contains no task IDs, counts, contents or owner identities.

All active members may read and select existing labels. Only workspace admins
create, rename, recolor, delete or merge registry entities. Every endpoint
checks the exact workspace and the normal enterprise/PAT boundaries. Writes
also require the existing same-origin mutation check. Inputs are strict Zod
objects; unknown properties cannot choose an owner or a second tenant.

Reads and writes return `Cache-Control: private, no-store`. Invalid input is
400, denied identity/membership/role is 403, and an unknown or foreign label in
an admitted workspace is 404. A duplicate name returns 409 with
`{error:{code:"task_label_conflict",detail:"name_taken"}}`. An overlapping
registry edit can return 409 with `detail:"changed"`; refresh the list and
retry the person's intended change. Merging a label into itself is rejected.

## Task writers and older clients

Task metadata now carries `labelIds`, an ordered set of at most 12 workspace
label UUIDs. The relational `issue_label_refs` table stores the authoritative
association. The existing `labels: [{name,color}]` field remains a
server-derived display snapshot, preserving older task readers and filters.
Clients must not use that snapshot to rename or recolor registry entities.

The existing `issue-metadata.updateIssueMetadata` action and Desktop RPC accept
`patch: {labelIds: [...]}` with the task's current revision. The existing
create-only command accepts `labelIds` as well. Both use the ordinary task
authorization and revision/receipt path; they do not add a second task writer.
Supplying `labels` and `labelIds` together is invalid. An inaccessible task,
a foreign/deleted label, or an invalid ID does not partially change a task or
leave a create receipt.

For compatibility, a legacy `labels` patch resolves its names to existing
entities in the task's workspace, ignores the requested display colors, and
persists their IDs. An unknown name returns the existing
`issueMetadataInvalid` action failure. It never creates a workspace entity.
MCP name inputs use the same resolver and validate before other legacy
multi-action edits. Incoming Linear labels also resolve only existing local
entities; an unknown name is a `LinearSyncConflictError` explaining that a
workspace admin must register the label. Provider label IDs and colors cannot
become local label authority.

`getIssuePropertyOptions` and `getNewTaskOptions` expose `labelRecords` for
ID-aware clients. Their original `labels` field retains the name/color-only
shape so existing Desktop requests still satisfy their strict input schema.

## Persistence and concurrent edits

`workspace_issue_labels` stores typed workspace ID, UUID, name, color and
timestamps. `issue_label_refs` stores typed task/workspace/label IDs and
position. Composite foreign keys prevent a reference from naming a label or
task in another workspace. No settings JSON blob is introduced.

Task content triggers enforce references for every database writer, including
imports and writers that do not call a metadata action. They derive display
snapshots from existing entities and update the relational references in the
same transaction. A tenant move resolves only existing destination names;
it cannot retain source-workspace label IDs or create destination labels.

Registry mutations hold fresh workspace membership through the application
transaction. Rename/recolor, merge and deletion update every affected task
through `persistIssueMetadata`, preserving its revision, historical version,
review and live-list effects. Merge replaces the source ID with the target
and deduplicates a task that already has both. Delete removes the association.
Old `issue_versions` remain immutable. The existing workspace deletion sweep
discovers both new tables through their `workspace_id` column.

Task-side label reads take a nonwaiting share lock, so an editor holding a task
row cannot deadlock indefinitely behind a registry writer holding its label
row. A conflicting operation rolls back; it does not silently drop a label or
commit a mismatched snapshot. Registry writers lock multiple label IDs in
deterministic order.

## Migration and rollback

`20261120190715_workspace_task_labels.sql` was allocated by
`node scripts/new-migration.mjs workspace_task_labels`. It adds the entity and
reference tables, indexes and trigger functions. It does not edit previous
migrations or rewrite historical task versions.

For valid legacy arrays on tasks with an explicit `workspaceId`, backfill
creates one entity per workspace and case-insensitive name, then records the
references and IDs on the task. If historical spellings or colors disagree,
the earliest task's value wins, ordered by `createdAt`, task ID and label
position. The task's remaining document and metadata are retained. Unscoped
tasks and unreadable legacy label metadata remain unchanged; no tenant is
inferred from an owner, Team relation or label text.

The SQL is repeatable, including after a later label deletion or merge. It
does not resurrect a deleted entity from old `issue_versions`. Fresh replay
uses the normal complete migration runner. The upgrade test copies the real
task column/constraint/generated-column shape into a disposable schema,
seeds legacy data before this migration, then executes the exact SQL twice.

Rollback starts by reverting the new readers/writers. Existing name/color
snapshots remain readable by the prior application. A later reviewed migration
may remove both task triggers, their three helper functions, the reference table, entity table and
new composite index. Keep `labelIds` in historical snapshots until their
normal retention lifecycle removes them; they grant no access. No production
data or old migration file needs to be deleted to roll back the application.
