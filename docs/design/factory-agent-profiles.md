# Factory Agent Profiles

- **Status:** implemented; component visual review complete; production acceptance tracked in #1284
- **GitHub:** [#1284](https://github.com/alexj11324/Mikka/issues/1284)
- **Layout precedent:** existing Settings › Models and subscriptions, New task, and the thread's execution identity dialog. No new accepted Figma frame is claimed.
- **Product authority:** [Factory flow decision](decisions/2026-11-04-2200-factory-flow-like-warp.md).
- **Current behaviour:** [2026-11-15-1630](decisions/2026-11-15-1630-agent-profile-is-a-role.md) (content only, no automatic selection) and [2026-11-17-1800](decisions/2026-11-17-1800-one-agent-per-thread.md) (every dispatch names its Agent; a thread keeps it for life).

## What the person does

Save reusable roles: a name, a description, private instructions and controlled Skills. That is all an Agent 配置 holds ([decision 2026-11-15-1630](decisions/2026-11-15-1630-agent-profile-is-a-role.md)). It never sets or limits the model or the machine.

Three rules, which the UI and the Coordinator's instructions repeat:

1. An Agent 配置 is content only: name, description, instructions, Skills.
2. A task uses one only when someone names it: the person in New task, or the Coordinator by id from `list_factory_agent_profiles`. A task-form choice always wins. Nothing is chosen automatically, and stage dispatch (review, verify, the first implementation after a plan) runs without one.
3. The Agent, model and machine come from the task. Every dispatch names its Agent (none named: `agentRequired`); the person's explicit model wins, else that Agent's 优先使用的模型 in order, and it is placed by 运行位置. A thread never switches Agent.

A Profile is owned by the current person in the current workspace. It is not a Bot, physical Agent installation, credential, machine or task.

## Where it lives

Settings › Models and subscriptions › Agent 配置. Each row shows the name, description, version and whether it can be used (enabled, and its Skills still authorized). Row actions: edit, duplicate, archive, and the enable switch.

New task has an Agent 配置 chip in its header row beside the machine and Bot chips (R-90). Its menu offers 不用 Agent 配置 and each Profile, and ends with 管理, which opens Settings in a new tab so the draft stays. A selected Profile is sent as structured `profileId` beside `taskDestination`. A draft saved with the retired Default choice (`default`) reads as none.

A selection made since 2026-11-15 is frozen with `contentOnly: true`, source `explicit` and the task's own target. Older frozen selections keep the source and reason they were admitted with (`decision` with `capability_fit` / `stage_fit` / `only_suitable`, or `default`), and an older selection that pinned a model keeps that model fence on retry, recovery and continuation. The thread execution identity dialog shows the frozen Profile name, version, source and reason, and never reconstructs them from current settings.

## Role templates

Add opens a menu of a blank Profile and four starting points: Investigator, Planner, Implementer and Reviewer. A template is a copy, never a shared record: choosing one fills the editor with its instructions and initial Skills, and nothing exists until the person saves. Template revisions are versioned in `lib/factory/agent-profile-templates.ts`; a revision never rewrites a Profile created from an earlier one.

## Skills, sources and progressive disclosure

A Profile selects capabilities from one resolver over four closed sources:

| Source | Reference | Authority | Notes |
| --- | --- | --- | --- |
| Official | bare legacy id or `official:<id>` | Reviewed Mikka text shipped in the repository | IDs are immutable: a revised text is a new id |
| Personal | `personal:<skill id>` | The Profile owner's own enabled installation (`personal_skills`, #582) | Never auto-shared to a workspace |
| Workspace | `workspace:<skill id>` | An owner's explicit share to the current team workspace plus active membership and the organization sharing policy | Revocation stops future runs |
| Repository | `repository:<name>` | `.claude/skills/<name>/SKILL.md` or `.agents/skills/<name>/SKILL.md` in the task's own checkout | Discovered and pinned by the daemon when the run starts |

The Profile row freezes the selected Skill envelope (name, description, version, digest, body). A later source edit does not rewrite a saved Profile: the pinned body stays, while a disabled, uninstalled, unshared or unauthorized source makes the Profile unavailable for new dispatch with a specific reason. Changing the Skill reference set re-resolves against current entitlements. The editor shows source, version, availability and a share action for team workspaces; a free-text field declares repository Skills because only the run's checkout can discover them. Skill selection grants no tool, credential, account or service permission. Counts and bodies are bounded: a Profile declares at most 12 references (`lib/factory/agent-profile-definition.ts:33`), and a claim carries at most 12 assigned and 12 declared Skills (`packages/protocol/src/skill.ts:83`, `packages/daemon/src/agents/run-context.ts`). A body is at most 20,000 characters in the protocol schema and at most 20,000 UTF-8 bytes wherever the daemon reads it; a repository `SKILL.md` outside 1..20,000 bytes is refused (`packages/protocol/src/skill.ts:84-93`, `lib/plugins/skill-source.ts`). The run manifest is 2..512 KiB and holds at most 24 Skills (`packages/daemon/src/agents/mikka-mcp-backend.mjs:683-685`). Artifact-inspection and other MCP context limits are a different surface and never bound a Skill body.

The brief carries only each Skill's id, name and purpose plus the `load_skill` instruction. The server sends the frozen bodies to the owner's daemon at claim; the daemon writes them (and any declared repository Skill it pinned from the checkout) under `profile-skills/manifest.json` in the run directory, never the worktree. The `mikka` MCP server exposes `load_skill`: it serves exactly one pinned body, verifies its SHA-256 and writes a write-once receipt. Both official Claude Code and Codex runs use this server, locally and in a cloud task machine. The brief never contains a body, so a harness that reads nothing still cannot claim to have applied it.

The run identity dialog lists the configured Skills separately from the daemon-receipted loads. A configured Skill without a receipt is shown as not loaded; the UI never reconstructs either list from current settings. The frozen Profile row and JSONB snapshots remain the historical source of truth.

## Fields and precedents

| Field or action | Mikka behavior | Precedent |
| --- | --- | --- |
| Name, description | Owner-edited public summary; instructions remain separate | [Warp custom agents](https://docs.warp.dev/factories/factory-agents/creating-custom-agents/) |
| Icon and colour | A dotted glyph and a colour from closed sets, stored beside the definition and outside its digest; derived from the name and description when none is chosen | Alex, 2026-11-10 |
| Private instructions | Saved with the other fields | Warp configuration's prompt editing |
| Skills | Checkboxes over the unified official/personal/workspace catalogue, declared repository names, and on-demand loading | [Warp factory agents](https://docs.warp.dev/factories/factory-agents/) and Mikka [Agent-as-Code](agent-as-code.md) |
| Enable | One row switch | Existing Mikka switches |
| Edit, duplicate, archive | Row action menu; archive confirms by name and retains historical runs | Existing Mikka settings menus |

Saving drops any model, Agent, effort or tag an older row still holds. No field grants tools, changes credentials, or expands authorization.

## Layout and states

| State | Presentation and recovery |
| --- | --- |
| First use / empty | 没有自定义 Agent 配置; Add creates the first one. Tasks run without one. |
| Loading | Existing SettingsLoading rows. |
| Read failure | SettingsSaveError / InlineLoadError with reload; a chosen Profile cannot dispatch while it is unknown. |
| Disabled / unavailable | Localized reason on the row; the task menu disables it. 不用 Agent 配置 is always available. |
| Skill removed | The reference is marked unavailable and can be unchecked before saving. |
| Concurrent edit | Version conflict keeps the draft and offers reload. |
| Unconfirmed save | Draft and request identity are retained; retry sends the same definition. |
| Narrow screen / dark mode | Shared settings layout and tokens. |

## Components and copy

Uses SettingsSection, SettingRow, SettingsLoading, SettingsSaveError, Dialog, AlertDialog, FieldGroup/Field/FieldSet, Input, Textarea, Checkbox and Switch.

New business components:
- `components/settings/factory-profiles-settings.tsx`
- `components/settings/factory-profiles-data.ts` (scoped reads and typed mutation requests)
- `components/coordinator/task-profile-picker.tsx`

The existing settings/data primitives do not provide this Profile-specific API or editor. UI strings live in `Settings.agentProfiles` in both message catalogues. Dialogs have titles and fields, with no explanatory subtitle.

Rules: R-01, R-22/23, R-30/31/32/33/34, R-40/41/42/43, R-70, R-74, R-90. Settings-pages guidance is applied within the existing Mikka hierarchy and components.

## User-task review

| Person's task | Behaviour |
| --- | --- |
| Run without configuration | Tasks run without an Agent 配置; nothing to set up |
| Make distinct implementation and review roles | Two Profiles with different instructions and Skills |
| Choose a role for one task | New task's Agent 配置 chip sends the exact Profile ID |
| Let the Coordinator pick a role | It lists the Profiles and passes one's id when it fits; the thread shows the choice |
| Pause or stop using a Profile | Disable, or archive with a named confirmation; history stays intact |
| Explain a previous run | Frozen Profile version, source and reason in the run identity dialog |

## Review and verification record

Source and type review cover the paths above. A Docker sandbox production build rendered the actual components in an isolated visual fixture with synthetic data: desktop and 390px layouts, empty/error states, dark mode, unavailable task choices and frozen/default Profile details were inspected. These component screenshots establish layout behavior, not authentication, provider execution or final-commit production acceptance. The PR attaches the visual evidence; #1284 tracks the immutable revision, real account acceptance and CC/Codex collaboration receipts.
