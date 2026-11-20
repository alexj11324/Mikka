# Personal keyboard shortcuts and settings search

This reference is for frontend developers integrating personal keyboard
shortcuts and row-level settings search for #2957. The backend uses the P1
settings endpoints, field guards, owner authorization, and reset behavior.
Action IDs and conflict types are exported from
[`@mikka/protocol/keyboard-shortcuts`](../../packages/protocol/src/keyboard-shortcuts.ts).

## Read and update bindings

These authenticated endpoints use the active workspace when `workspaceId` is
omitted. An explicit workspace must have an active membership for the caller.
Bindings belong to the signed-in account and apply across its workspaces:

| Endpoint | Result |
| --- | --- |
| `GET /api/settings/personal?workspaceId=WORKSPACE_ID` | Returns `{workspaceId, values}`. Each setting contains `{value, source}`. |
| `PATCH /api/settings/personal?workspaceId=WORKSPACE_ID` | Validates and atomically applies `{values: {...}}`, then returns the settings view. |
| `POST /api/settings/personal/reset?workspaceId=WORKSPACE_ID` | Accepts `{"group":"keyboard_shortcuts"}` and returns the reset settings view. |
| `GET /api/settings/schema` | Returns `{settings: [...]}` with row metadata, defaults, and write scope. |

Replace `WORKSPACE_ID` with an accessible workspace ID. The following PATCH
body changes the existing search action:

```json
{
  "values": {
    "keyboardShortcuts.search.open": "Mod+Shift+KeyK"
  }
}
```

The response includes this entry in `values`:

```json
{
  "keyboardShortcuts.search.open": {
    "value": "Mod+Shift+KeyK",
    "source": "personal"
  }
}
```

Send `null` to restore the action's default and `source: "default"`. Send an
empty string to disable an action explicitly with `source: "personal"`.
Shortcut fields reject workspace writes, including administrator writes.
The caller cannot supply a different owner. Invalid fields or bindings return
HTTP 400; inaccessible workspaces return HTTP 403.

## Handle conflicts

Bindings use a physical keyboard code and normalized modifiers. `Mod` means
Meta on Apple and Ctrl elsewhere. The server checks both platform mappings,
the action's active surfaces, saved overrides, defaults, and every value in
the same patch. Bare or Shift-only navigation keys remain reserved for their
existing controls and editors.

A conflicting patch returns HTTP 409 with this structure:

```json
{
  "error": "keyboardShortcutConflict",
  "conflicts": [{
    "actions": ["search.open", "settings.open"],
    "bindings": ["Mod+KeyK", "Mod+KeyK"],
    "platforms": ["apple", "other"]
  }]
}
```

The server rejects the whole patch, including unrelated settings in it. To
swap two bindings, send both changes in one patch. Concurrent changes use the
same account lock, so they cannot introduce a conflict after validation.

## Render and refresh settings

Shortcut schema rows have `page: "shortcuts"`, `group: "keyboard_shortcuts"`,
a stable `action`, and a `context` containing the existing activation scope,
editing eligibility, dialog eligibility, and optional task target. Use the
schema's bilingual `label` and `keywords` for row-level search. The existing
sidebar search remains a separate navigation surface.

The `SettingsRegistry` namespace in the English and Chinese message catalogues
owns display labels and search terms. Shared actions reference their stable
`metadataKey`; the backend registry resolves it through `settingMetadata`.

After a shortcut write commits, the existing live stream publishes
`workspace_settings` to the owner in every active workspace. Its payload
contains only the workspace ID. Other members and suspended memberships
receive no shortcut invalidation. Refresh the personal settings view when
this key changes.

Replace the original hardcoded keyboard listener for each action when
consuming these bindings. Preserve the owning component's IME, repeat,
editing, dialog, and action-readiness guards, and compare the full modifier
set. This backend work does not implement or verify that frontend integration.

## Storage and extension

Each action has one personal registry field. The typed `keyboard_shortcuts`
entity stores its account, action ID, and nullable binding; the P1 typed text
row is an atomic mirror. Neither table stores a settings JSON blob. Adding
an action after this table exists requires its declaration and metadata,
without another migration or server action.

The migration is additive and repeatable. To roll back application code,
retain both tables and personal preferences. For the verified action
inventory, conflict scopes, and rationale, see the
[keyboard shortcut decision](../design/decisions/2026-11-20-1943-keyboard-shortcut-settings.md).
