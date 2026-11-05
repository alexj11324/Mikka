# Factory Agent Profiles

- **Status:** implemented; component visual review complete; production acceptance tracked in #1284
- **GitHub:** [#1284](https://github.com/alexj11324/Mikka/issues/1284)
- **Layout precedent:** existing Settings › Models and subscriptions, New task, and the thread's execution identity dialog. No new accepted Figma frame is claimed.
- **Product authority:** [Factory flow decision](decisions/2026-11-04-2200-factory-flow-like-warp.md).

## What the person does

Save reusable coding roles with responsibilities, capability tags, an Agent/model policy, reasoning effort, private instructions and controlled Skills. Choose one for a task, or let the existing host select an eligible Profile for that task's stage.

A Profile is a logical configuration owned by the current person in the current workspace. It is not a Bot, physical Agent installation, credential, machine or task. Profiles may share an Agent and model while differing in responsibilities and instructions.

## Where it lives

Settings › Models and subscriptions › the current workspace's model defaults › Factory Agent Profiles. The section follows Preferred models. It uses the same section, rows, action menu and explicit edit dialog as nearby settings.

New task has a Profile selector below its existing machine/Bot/title row. Automatic selection omits the explicit Profile ID. A selected Profile is sent as structured `profileId` beside `taskDestination`, through the existing Coordinator submission; the selector does not put a claimed choice into natural-language instructions.

Task availability is requested for the explicitly selected cloud or device destination. A location change invalidates the previous availability result while the host evaluates the new destination; dispatch revalidates it again.

The existing thread execution identity dialog shows the frozen Profile name, version, digest, selection source and reason beside the run's actual Agent, model and credential kind. Opening a thread from a task uses the same dialog. It never reconstructs historical Profile data from the current settings.

## Fields and precedents

| Field or action | Mikka behavior | Precedent |
| --- | --- | --- |
| Name, responsibilities, roles | Owner-edited public summary; instructions remain separate | [Warp custom agents](https://docs.warp.dev/factories/factory-agents/creating-custom-agents/) |
| Agent and model | Auto / Claude Code / Codex; inherit preferred models or pin an authorized model/source | [Warp agent configuration](https://docs.warp.dev/factories/factory-agents/configuration/), existing Mikka Preferred models |
| Reasoning effort | Default or the supported profile effort values | #1284 and existing per-run effort configuration |
| Private instructions | Explicitly saved with the other Profile fields | Warp configuration's prompt editing |
| Skills | Checkboxes over the host's controlled, versioned catalogue | [Warp factory agents](https://docs.warp.dev/factories/factory-agents/) and Mikka [Agent-as-Code](agent-as-code.md) |
| Enable | One row switch; confirmed server value stays visible until saved | Existing Mikka subscription/device switches |
| Edit, duplicate, archive | Row action menu; archive confirms by name and retains historical runs | Existing Mikka settings menus and archive flows |

No field grants new tools, changes credentials, or expands authorization. Model source labels come only from authorized catalogue data. Source references are request identifiers, not displayed credential values.

## Layout and states

| State | Presentation and recovery |
| --- | --- |
| First use / empty | Read-only Default profile row, inherited preferred-model policy and its real availability; Add creates the first custom Profile. No stored default is required. |
| Normal | Name, responsibilities, capability tags, Agent/model policy, version, availability; enable switch and row menu. |
| Loading | Existing SettingsLoading rows; dispatch retains Automatic selection. |
| Read failure | Existing SettingsSaveError / InlineLoadError with reload; an explicit selection cannot dispatch while its availability is unknown. |
| Disabled / unavailable | Localized reason on the row; unavailable choices are disabled in the task menu. Editing remains available. |
| Fixed source removed | Editor retains the fixed policy, flags the missing selection and requires an authorized replacement. |
| Skill removed | Existing reference is marked unavailable and can be unchecked before saving. |
| Concurrent edit | Version conflict keeps the draft and offers reload. The stored newer version is not overwritten. |
| Unconfirmed save | Draft and request identity are retained; retry sends the same definition. A new create uses an idempotency ID. |
| Narrow screen | Settings row actions wrap below the content; editor fields collapse to one column; dialog scrolls inside the viewport; new-task selectors wrap. |
| Dark mode | Shared control/background/status tokens only; no custom colors or border-input styling. |

## Components and copy

Uses SettingsSection, SettingRow, SettingsLoading, SettingsSaveError, Dialog, AlertDialog, FieldGroup/Field/FieldSet, Input, Textarea, Select, Checkbox, Switch and the shared Agent/model labels.

New business components:
- `components/settings/factory-profiles-settings.tsx`
- `components/settings/factory-profiles-data.ts` (scoped reads and typed mutation requests)
- `components/coordinator/task-profile-picker.tsx`

The existing settings/data primitives do not provide this Profile-specific API or editor. UI strings live in `Settings.agentProfiles` in both message catalogues. Dialogs have titles and fields, with no explanatory subtitle.

Rules: R-01, R-22/23, R-30/31/32/33/34, R-40/41/42/43, R-70, R-74, R-90. Settings-pages guidance is applied within the existing Mikka hierarchy and components.

## User-task review

| Person's task | Before | After |
| --- | --- | --- |
| Run without configuration | Existing preferred-model flow | Same flow with a read-only default row; no setup gate |
| Make distinct implementation and review roles | Missing | Create two Profiles without new Bots or computers |
| Pin an authorized model/source | Global preferred-model defaults only | Per-Profile fixed selection; global defaults remain editable independently |
| Pause a Profile | Missing | Disable; historical run snapshots stay intact |
| Stop using a Profile | Missing | Archive with a named confirmation |
| Choose a role for one task | Missing | New task selector sends the exact Profile ID |
| Explain a previous run's selection | Physical run identity only | Frozen Profile version/source/reason in the same run identity dialog |
| Recover from a removed source, Skill or concurrent edit | Missing | Explicit errors, replacement/removal controls and reload |

## Review and verification record

Source and type review cover the paths above. A Docker sandbox production build rendered the actual components in an isolated visual fixture with synthetic data: desktop and 390px layouts, empty/error states, dark mode, unavailable task choices and frozen/default Profile details were inspected. These component screenshots establish layout behavior, not authentication, provider execution or final-commit production acceptance. The PR attaches the visual evidence; #1284 tracks the immutable revision, real account acceptance and CC/Codex collaboration receipts.
