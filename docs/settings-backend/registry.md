# Registered settings

`lib/settings/registry.ts` owns each setting's key, scopes, Zod guard, default,
write access, personal override rule, page and bilingual search metadata.
Clients import the wire types from `@mikka/protocol/settings`.

## Read and write

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/settings/personal?workspaceId=<uuid>` | Effective personal settings in the selected workspace |
| PATCH | `/api/settings/personal?workspaceId=<uuid>` | Write the signed-in person's overrides and return the complete effective view |
| POST | `/api/settings/personal/reset?workspaceId=<uuid>` | Reset one group to inherited values |
| GET | `/api/settings/workspace/<uuid>` | Workspace defaults without the reader's personal overrides |
| PATCH | `/api/settings/workspace/<uuid>` | Admin writes workspace defaults |
| POST | `/api/settings/workspace/<uuid>/reset` | Admin resets one group to registry defaults |
| GET | `/api/settings/schema` | Authenticated schema metadata for rendering and row search |

PATCH accepts `{"values":{"archiveIdleAfterDays":7}}`. Reset accepts
`{"group":"threads"}`. A PATCH value of `null` also resets that field. The
server rejects unknown keys, unknown top-level properties and invalid scopes,
then parses each non-null value with that field's own guard. It does not coerce
strings into numbers or booleans.

The settings response is:

```json
{
  "workspaceId": "00000000-0000-4000-8000-000000000001",
  "values": {
    "archiveIdleAfterDays": { "value": 7, "source": "workspace" }
  }
}
```

`source` is `personal`, `workspace` or `default`. Only null or an absent row
inherits: zero, false and an empty string remain explicit values. Personal
archive preferences are account-wide. Personal thread-title settings are
scoped to their workspace. A workspace reader never receives another member's
personal settings.

The `settings.*` desktop RPC operations call the same actions and registry.
An explicit inaccessible workspace is refused. Writers re-check and lock
current workspace membership; workspace changes require an administrator.
Personal writes derive the owner from the authenticated session, never input.

## Storage and compatibility

`personal_setting_values` and `workspace_setting_values` have separate boolean,
integer, text and text-array columns. A database constraint permits at most
one non-null value. All-null rows record a reset and make migration replay
safe. There is no JSON settings blob.

The additive migration copies existing archive and thread-title preferences
without overwriting later edits. The existing preferences and thread-title
actions use the registry writer for those fields. Writes also maintain their
legacy typed columns so existing readers keep working. Unrelated preference
columns and workspace name/slug/icon actions retain their existing writers.

`subagentMaxConcurrent` demonstrates extension without a per-field migration
or action: its registry entry provides an integer guard (1–20), default 6,
workspace/admin scope, typed persistence, reset and schema metadata. P2 owns
consuming this setting at the subagent admission boundary; P1 only provides
the setting contract and storage.

Rollback deploys the prior application while retaining the additive tables.
The mirrored legacy columns remain readable. Do not delete saved preferences
or edit an executed migration to roll back application code.

## Validation

`lib/settings/registry.test.ts` owns null inheritance, explicit overrides and
field guard tests. `lib/settings/store.db.test.ts` exercises the actual route
handlers and PostgreSQL persistence, cross-workspace and role refusals,
legacy action compatibility, upgrade backfill and repeat migration execution.
They are included in the existing settings unit and PG17 CI commands.
