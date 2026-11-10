# Factory Agent Profiles

- **Status:** implemented; component visual review complete; production acceptance tracked in #1284
- **GitHub:** [#1284](https://github.com/alexj11324/Mikka/issues/1284)
- **Layout precedent:** existing Settings › Models and subscriptions, New task, and the thread's execution identity dialog. No new accepted Figma frame is claimed.
- **Product authority:** [Factory flow decision](decisions/2026-11-04-2200-factory-flow-like-warp.md).

## What the person does

Save reusable coding roles with responsibilities, capability tags, an Agent/model policy, reasoning effort, private instructions and controlled Skills. Choose one for a task, or let the existing host select an eligible Profile for that task's stage.

A Profile is a logical configuration owned by the current person in the current workspace. It is not a Bot, physical Agent installation, credential, machine or task. Profiles may share an Agent and model while differing in responsibilities and instructions.

## Where it lives

Settings › Models and subscriptions › the current workspace's model defaults › Agent 配置. Each row's state is a status badge (可运行 / 已停用 / its reason; R-34, R-87); only a toggle's result is announced. The section follows Preferred models. It uses the same section, rows, action menu and explicit edit dialog as nearby settings.

New task has an Agent 配置 chip in its header row beside the machine and Bot chips, drawn the same way (`h-7 rounded-full`, icon first, R-90); its menu ends with 管理, which opens Settings in a new tab so the task draft stays. A load failure or an unavailable choice shows under the row. Automatic selection omits the explicit Profile ID. A selected Profile is sent as structured `profileId` beside `taskDestination`, through the existing Coordinator submission; the selector does not put a claimed choice into natural-language instructions.

The same menu offers the existing built-in Default profile, including when custom Profiles are enabled. It uses the Default row's availability and inherits preferred models. Its structured task-form reference is the closed literal `default`; custom references remain UUIDs. The stored user event is authoritative: a model's text or tool argument cannot select Default on its own or replace the user's pin. Mutable Profile APIs remain UUID-only.

An explicit Default choice enters the existing preferred-model dispatcher, preserving named Agent/model/source constraints, difficulty routing and current authorization. Its frozen receipt still has source and reason `default`, with the same immutable definition and no Profile Decision receipt. An explicit model remains a picked model; a named Agent alone still inherits that Agent's list. Automatic selection keeps its existing Decision and refusal behavior. This is an entry point for the person's existing Default choice, not a change to Automatic fallback policy.

The host-only default continuation selector may retain the same structured Default pin, never a different custom Profile. Question answers keep the original frozen native role and session guards; independent review stages keep their own host-selected Profile.

For an independent Review or Verify selection, the host describes the current read-only work against the locked task's candidate and request epoch. Its `currentWork` allowlist retains the actual candidate and producer, nullable SHA, and the existing stage's responsibility and validation-evidence requirement; it never serializes private instructions, Skill content, native sessions or a producer report. The original producer contract and the receipt-bound Owner context from `currentFactoryRequest` are separate acceptance references, not instructions to repeat implementation, a consumed question or producer self-review. This internal context is supplied only when an automatic Profile Decision is needed; it is not a public request or tool field. It describes the role to select and grants no permission. The existing check queue still validates the candidate, resolves its fixed SHA and freezes the independent assignment; Default, explicit choices and frozen check retries retain their existing paths. `none` and uncertain selections still block the unstarted check.

Automatic Profile selection asks one constrained choice that binds an exact currently eligible Profile ID and the model's primary reason (`capability_fit` or `stage_fit`); `none` is a separate refusal choice. Profile and reason depend on each other, so they are not separate questions in the same request ([Decisions guidance](https://vercel.com/i/what-is-openai-decisions-api)). The host only maps an exact listed pair back to its ID and reason. It does not fill in a reason for a bare ID or accept the old two-answer format. Missing/refused answers and confidence below 0.55 remain unavailable; omitted confidence retains the existing behavior. Receipt validation, current authorization, independent check identity and candidate recovery are unchanged.

The existing 100-Profile limit produces at most 201 choices, within the provider's [255-choice limit](https://developers.openai.com/api/reference/resources/decisions/methods/create), without truncating the eligible catalogue. Private Profile instructions remain outside the Decision input; unlike `currentWork`, the candidate list carries each eligible Profile's bounded Skill metadata — id, name, a description capped at 200 characters, and source — because the Decision matches declared capabilities against the assignment. It never carries a body, path, source revision or credential. A Profile whose Skills no longer resolve is not offered as a candidate: its closed availability code (`skill_missing`, `skill_disabled`, `skill_forbidden` or `skills_changed`) is recorded in the bounded Decision diagnostics. Existing frozen selections, including the historical `only_suitable` reason, retain their original role, reason and receipt; native continuation does not run this new selection protocol again.

Task availability is requested for the explicitly selected cloud or device destination. A location change invalidates the previous availability result while the host evaluates the new destination; dispatch revalidates it again. The read-only `checking` allowance state remains selectable and shows a neutral pending status: it requests the existing authoritative check at dispatch, not permission to run. Confirmed refusals, missing reads, disabled or archived Profiles stay unselectable; enabled/archive state takes precedence even over an available or checking projection. The task form sends only the structured Profile reference, never a client availability grant.

A selected built-in Default keeps its structured intent so the normal dispatcher can refresh the already authorized subscription and apply the current preferred-source order. The management preview stays read-only, with no background quota probe or source refresh. Its unresolved allowance is shown as checking, not as available; quota preparation does not erase provider-failure memory. Dispatch, queue and claim retain the strict quota and authorization checks for Default and custom Profiles.

The existing thread execution identity dialog shows the frozen Profile name, version, selection source and reason (stored as a code — `capability_fit`, `stage_fit`, `only_suitable` — and worded in the reader's language; a run frozen before the codes reads as the neutral 按任务能力选择). The configuration digest stays in the snapshot but is not shown beside the run's actual Agent, model and credential kind. Opening a thread from a task uses the same dialog. It never reconstructs historical Profile data from the current settings.

## Role templates

Add opens a menu of a blank Profile and four starting points: Investigator, Planner, Implementer and Reviewer. A template is a copy, never a shared record: choosing one fills the normal editor (roles, private instructions, an initial Skill selection, automatic Agent and inherited model), and nothing exists until the person saves. Saving creates one ordinary custom Profile; it creates no Bot, machine or extra Profile. Template revisions are versioned in `lib/factory/agent-profile-templates.ts`; a revision never rewrites a Profile created from an earlier one, and the read-only Default stays empty and unchanged. Templates are editor data only: they enter the automatic Decision catalogue after a person instantiates and enables them.

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
| Name, responsibilities, roles | Owner-edited public summary; instructions remain separate | [Warp custom agents](https://docs.warp.dev/factories/factory-agents/creating-custom-agents/) |
| Icon and colour | A dotted glyph (`square`, `chevrons`, `lens`, `lines`, `check`, `stairs`, `diamond`, `arrow`) and a colour (`ink`, `graphite`, `teal`, `pink`), both closed sets stored as nullable `icon` and `color` columns beside the definition, outside its digest. A new Profile with none chosen stores one derived from its roles, then name and description; an existing row's null reads as that derived default. Default always draws `square` in `ink`. `ProfileMark` draws it first wherever a Profile is named (settings rows and editor, New task's Agent 配置, a task conversation's stretch label, the run identity dialog), with the Agent's brand mark smaller beside it. Shape tells Profiles apart; colour only assists. The run identity dialog and stretch label read the Profile's current mark, not a frozen copy | Alex, 2026-11-10; affectUI Live Session agent glyphs |
| Agent and model | Auto / Claude Code / Codex; inherit preferred models or pin an authorized model/source | [Warp agent configuration](https://docs.warp.dev/factories/factory-agents/configuration/), existing Mikka Preferred models |
| Reasoning effort | Default or the supported profile effort values | #1284 and existing per-run effort configuration |
| Private instructions | Explicitly saved with the other Profile fields | Warp configuration's prompt editing |
| Skills | Checkboxes over the unified official/personal/workspace catalogue, declared repository names, and on-demand loading | [Warp factory agents](https://docs.warp.dev/factories/factory-agents/) and Mikka [Agent-as-Code](agent-as-code.md) |
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
| Disabled / unavailable | Localized reason on the row; confirmed unavailable choices are disabled in the task menu. Allowance `checking` stays selectable for Default and enabled, unarchived custom Profiles, with its unresolved state visible so normal dispatch can check it. Editing remains available. |
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
| Use preferred models for one task while custom Profiles exist | Default available only as a read-only settings row | New task can explicitly select Default with its current availability |
| Explain a previous run's selection | Physical run identity only | Frozen Profile version/source/reason in the same run identity dialog |
| Start a role from a known responsibility | Blank Profile only | Investigator, Planner, Implementer and Reviewer templates fill the editor; saving creates one ordinary Profile |
| Use an installed or shared Skill | The three built-in texts only | Personal, explicitly shared workspace and declared repository Skills, pinned with a load receipt per run |
| Recover from a removed source, Skill or concurrent edit | Missing | Explicit errors, replacement/removal controls and reload |

## Review and verification record

Source and type review cover the paths above. A Docker sandbox production build rendered the actual components in an isolated visual fixture with synthetic data: desktop and 390px layouts, empty/error states, dark mode, unavailable task choices and frozen/default Profile details were inspected. These component screenshots establish layout behavior, not authentication, provider execution or final-commit production acceptance. The PR attaches the visual evidence; #1284 tracks the immutable revision, real account acceptance and CC/Codex collaboration receipts.
