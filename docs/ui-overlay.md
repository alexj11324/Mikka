# UI slots and the hosted UI layer

The official web app and desktop installers lay a private BoardUI layer over
this repository's interface ([decision 2026-11-06-2000](design/decisions/2026-11-06-2000-hosted-ui-overlay.md)).
The paid code lives only in `alexj11324/mikka-hosted-ui`; this repository
never imports it. The build pipeline that checks the layer out is issue #1527.

## The two builds

| | Open-source build | Official build |
| --- | --- | --- |
| `MIKKA_UI_OVERLAY_DIR` | unset | path of the `mikka-hosted-ui` checkout, inside this repository (CI uses `.hosted-ui/`, which is gitignored) |
| `@ui-slot/<name>` | `components/slots/<name>.tsx` | `$MIKKA_UI_OVERLAY_DIR/slots/<name>.tsx` when the layer has it, else the default |
| `@hosted/*` | does not resolve | `$MIKKA_UI_OVERLAY_DIR/*` |

`lib/ui-overlay.mjs` decides this once, and both bundlers read it:
`next.config.mjs` (Turbopack `resolveAlias` and webpack `resolve.alias`) and
the desktop renderer's Vite plugin (`apps/frontend/scripts/application-plugin.mjs`).
`tsconfig.json` maps `@ui-slot/*` to the defaults, so typecheck, lint and tests
in this repository always see the open-source build. The layer must sit inside
the repository: Turbopack reads nothing outside its root, and the layer
resolves `react` and this app's modules from this repository's `node_modules`.
A missing directory, or one outside the repository, fails the build.

## Slots

| Slot | Default | Props | Callers import |
| --- | --- | --- | --- |
| `bot-avatar` | bloub blob | `BotAvatarProps` in `components/slots/bot-avatar-contract.ts` (`id` is the bot's id when the caller has one; `coordinator` is set by `COORDINATOR_AVATAR`) | `BotAvatar`, `CoordinatorAvatar`, `colorFor`, `COORDINATOR_AVATAR` from `@/components/nav/bot-avatar` |
| `chat-message` | today's message rows (`Message`, `Bubble`, `ReplyWaiting`) | `ChatMessageProps`, `ChatWaitingProps` in `components/slots/chat-message-contract.ts`; also exports `CHAT_SURFACE` | `coordinator-chat.tsx`, through `@ui-slot/chat-message` |
| `reply-activity` | a reply's thinking and tool calls as Trace rows | `ActivityThinkingProps`, `ActivityToolView`, `ActivityGroupProps` in `components/slots/reply-activity-contract.ts`; exports `ActivityList`, `ActivityThinking`, `ActivityTool`, `ActivityGroup` | `components/coordinator/reply-activity.tsx`, through `@ui-slot/reply-activity` |
| `settings-frame` | app rail and window bar around settings (`AppFrame`) | `SettingsFrameProps` in `components/slots/settings-frame-contract.ts`; optional `OWN_SETTINGS_FRAME` (`false` or missing: settings stay in the workspace frame; `true`: `IssueWorkspace` draws settings in this frame) | `SettingsFrame` from `@/components/settings/settings-shell`; `IssueWorkspace` |
| `settings-sidebar` | settings section list | `SettingsSidebarProps` in `components/slots/settings-sidebar-contract.ts` | `SettingsSidebar` from `@/components/settings/settings-sidebar` |
| `task-workspace` | the workspace a task is created in (new-task breadcrumb) or fixed to (task properties) | `TaskWorkspaceProps` in `components/slots/task-workspace-contract.ts` | `CreateIssueDialog`; `IssueDetailProperties` |
| `settings-content` | heading and card around a section (`AppShellContent variant="settings"`) | `SettingsContentFrameProps` in `components/slots/settings-content-contract.ts` | `SettingsView` |
| `settings-account` | 账户 body (picture, name, email, sign-out, delete account) | `SettingsAccountProps` in `components/slots/settings-account-contract.ts` | `AccountSettings` from `@/components/settings/account-settings` |
| `settings-general` | 常规 body (icon, name, address, transfer, delete, archived bots) | `SettingsGeneralProps` in `components/slots/settings-general-contract.ts` | `SettingsView` |
| `settings-memory` | 记忆与建议 body (switch, facts by kind, correct, delete) | `SettingsMemoryProps` in `components/slots/settings-memory-contract.ts` | `MemorySettings` from `@/components/settings/memory-settings` |
| `settings-models` | 模型与订阅 body (subscriptions, API keys, fallback, model order, profiles, sharing) | `SettingsModelsProps` in `components/slots/settings-models-contract.ts` | `SettingsView` |
| `settings-notifications` | 通知 body (push switches, when to push) | `SettingsNotificationsProps` in `components/slots/settings-notifications-contract.ts` | `NotificationSettings` from `@/components/settings/notifications-settings` |
| `settings-preferences` | 偏好设置 body (appearance, language, task prefix, replay onboarding) | `SettingsPreferencesProps` in `components/slots/settings-preferences-contract.ts` | `SettingsView` |
| `settings-privacy` | 数据与隐私 body (data export, shared links) | `SettingsPrivacyProps` in `components/slots/settings-privacy-contract.ts` | `PrivacySettings` from `@/components/settings/privacy-settings` |
| `settings-secrets` | 密钥与登录 / 密钥与环境 body (my secrets and logins, workspace secrets) | `SettingsSecretsProps` in `components/slots/settings-secrets-contract.ts` | `SecretsPage` from `@/components/settings/secrets-page` |
| `settings-security` | 安全 body (password, signed-in devices, Google sign-in) | `SettingsSecurityProps` in `components/slots/settings-security-contract.ts` | `SettingsView` |

A slot changes how something looks, never what it does. Data, state and
behaviour stay in this repository and reach the slot as props. A layer slot
exports the same named component as the default, takes the same props and is
a client component (`'use client'`).

**Required and optional exports.** Production builds this repository's main
with the layer's main, and the two merge at different times. A slot's
required exports are listed in `UI_SLOT_EXPORTS` (`lib/ui-overlay.mjs`); every
layer must export them, and callers may import only those by name. Anything
else a slot exports is optional and is read through a namespace import with a
fallback (`import * as slot from '@ui-slot/<name>'`, then
`slot.X ?? fallback`): a layer that predates it still builds, because a
missing named import fails the production build while a missing namespace
member is just `undefined`. `lib/ui-overlay.test.mjs` fails when a caller
imports any other name by name. To make a name required, merge the layer that
exports it first, then add it to `UI_SLOT_EXPORTS`. On its side, the layer's CI
builds each change together with this repository's main before it merges.

The settings slots are filled together: a layer's frame draws the whole settings page, and its sidebar and content slots hand it their section list and title rather than drawing their own.

Adding a slot: move today's component to `components/slots/<name>.tsx`, put
its props in a contract file next to it, keep the public import path
re-exporting it from `@ui-slot/<name>`, add the name to `UI_SLOTS` and its
required exports to `UI_SLOT_EXPORTS`, and add a row above. Merge the layer's
slot only after this repository's slot is on main.

## Rules for the layer

- **Imports.** BoardUI's own source imports its files with `@/` (for example
  `@/components/base/...`, `@/utils/cx`). Here `@/` is this repository, so
  inside the layer those imports are written `@hosted/...`. The layer's
  `pnpm bdui add <name>` rewrites them after each add (see its `CLAUDE.md`).
  `@/` in the layer means this repository: use it for this app's types,
  hooks and contracts, such as `@/components/slots/bot-avatar-contract`.
- **Styles.** The layer has one style entry, `styles/overlay.css`, which its
  slots import. Its utilities sit in the `components` layer, below this app's
  `utilities`: a class both apps generate (`hidden`, `md:grid`) keeps this
  app's order. A layer class that must win over one of this app's utilities
  is marked important (`bg-transparent!`). It holds BoardUI's theme tokens and fonts and an `@source` for
  the layer's files: Tailwind skips gitignored paths, so without it BoardUI's
  classes are never generated. It does not import BoardUI's `globals.css`
  base reset or the shadcn block of its `globals.css` (whose tokens share this
  app's names). A few of BoardUI's theme variables share a name with this
  app's (`--font-sans`, `--color-blue-400`); this app's utilities inline their
  own values, so pages outside the slots look the same in both builds.
- **Dependencies.** Packages BoardUI needs that this repository lacks are
  installed in the layer. `react` and `react-dom` come from this repository
  only.
- **Source maps.** No public output of an official build may carry the
  layer's source (issue #1527, item 5).
