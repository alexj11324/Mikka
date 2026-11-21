# Personal keyboard shortcuts

Issue #2956 P9; frontend integration belongs to #2957. The existing product
actions below have stable identities in `@mikka/protocol/keyboard-shortcuts`.
Their declarations derive personal P1 registry fields, schema/search metadata,
defaults and conflict detection. Adding an action does not add a migration or a
server action. No new `project` terminology is introduced.

Display labels and search terms live in the canonical English and Chinese
`SettingsRegistry` message catalogues. Shared declarations carry a stable
`metadataKey`; the registry resolves it through `settingMetadata` so the API
and settings rows use the same translations.

| Action ID | Default physical binding | Active surface |
| --- | --- | --- |
| `search.open` | `Mod+KeyK` | Global; Settings uses its own search |
| `settings.open` | `Mod+Comma` | Global |
| `task.create` | `KeyC` | Workspace, outside Settings |
| `sidebar.toggle` | `Mod+KeyB` | Global sidebar |
| `review.open` | `Mod+Shift+KeyB` | Workspace with a task to review |
| `board.assistant.toggle` | `Mod+KeyJ` | Board |
| `details.toggle` | `Mod+KeyI` | Details page |
| `devices.add` | `Mod+KeyN` | Devices settings |
| `theme.toggle` | `KeyD` | Global |

These bindings come from the current issue workspace, workspace switcher,
sidebar, board, detail, devices and theme components. The metadata also records
their existing editing/dialog eligibility. The search dialog's own toggle and
in-flight navigation/creation guards remain with their owning component.
Existing Escape, Tab, arrows, Enter and other control/editor navigation are not
configurable actions. Bare and Shift-only navigation bindings are refused.

Bindings normalize to modifier names followed by a physical keyboard code.
`Mod` means Meta on Apple and Ctrl elsewhere; explicit Ctrl/Meta also work.
Conflict detection checks both platforms. A global action overlaps every
surface; workspace actions overlap board/details; board, details and devices
are mutually exclusive. Exact modifiers distinguish sidebar toggle from review.
Frontend integration must replace the original hardcoded listeners and compare
the complete modifier set, not install a second listener. It retains IME,
editing, dialog, repeat and action-readiness guards. This backend change does
not claim that the existing UI already consumes personal bindings.

## API and storage

Use the P1 endpoints and authenticated workspace context:

- `GET /api/settings/personal?workspaceId=...`
- `PATCH /api/settings/personal?workspaceId=...` with, for example,
  `{"values":{"keyboardShortcuts.search.open":"Mod+Shift+KeyK"}}`.
- `POST /api/settings/personal/reset?workspaceId=...` with
  `{"group":"keyboard_shortcuts"}`.
- `GET /api/settings/schema` returns bilingual `label`, `keywords`, page
  `shortcuts`, the action ID and its `context`. The existing sidebar search
  remains separate from row matching over this metadata.

Values are account-wide and owner-only. Workspace writes are rejected even for
an administrator. A null value restores `source: default`; empty text disables
the action with `source: personal`. The account-wide `personal_setting_values`
text row owns the binding and is the source for conflict checks. The
`keyboard_shortcuts` table is an atomic, write-only mirror so rolling back to
the earlier shortcut implementation preserves choices. Neither stores JSON.

After acquiring the existing user row lock, a write validates all effective
defaults, saved overrides and the complete incoming patch before updating
either table. This permits a single-request swap while refusing conflicting
concurrent requests. Conflict returns HTTP 409 with
`{error:"keyboardShortcutConflict", conflicts:[{actions,bindings,platforms}]}`;
no partial update, including unrelated settings in the patch, is committed.
Reset applies to the whole group under the same lock.

After commit, pure shortcut writes publish the existing `workspace_settings`
key to this owner in every active workspace, including other open windows.
Other members and suspended memberships receive no shortcut invalidation. The
payload is the known workspace ID only; neither action IDs nor key values are
published. Mixed patches keep the existing invalidation for their other fields.

The migration is additive and idempotent. Application rollback retains both
tables and personal choices; it does not delete user settings. Test proof uses
the existing settings unit/PG17 suites and real HTTP handlers, including
ownership, scope, forged fields, concurrent conflicts, reset and SQL replay.
