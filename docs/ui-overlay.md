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
| `app-frame` | 外框: the app window around every page (frame, window bar slot, the rounded card) and the icon rail; the window bar's content, the pages and the right-hand panel are not part of it | `AppFrameProps`, `IconRailProps` in `components/slots/app-frame-contract.ts`; `RAIL_ITEMS` in `components/nav/rail-items.ts`; `UpdateButton` in `components/nav/icon-rail-view.tsx`; `SETTINGS_COLORS` in `components/app-frame-view.tsx` | `AppFrame` from `@/components/app-shell`, `IconRail` from `@/components/nav/icon-rail` |
| `all-threads` | 全部线程's window-bar button and the right column it opens | `AllThreadsToggleProps`, `AllThreadsColumnProps` in `components/slots/all-threads-contract.ts` (`pending` is the 待处理 task count for a layer that lists tasks) | `AllThreadsToggle`, `AllThreadsColumn` from `@/components/nav/all-threads` |
| `bot-tasks` | the bot panel's 线程 tab: the threads it dispatched in R-52's groups | `BotTasksProps` in `components/slots/bot-tasks-contract.ts`; tasks from `tasksOf` (`hooks/use-bot-tasks.ts`); optional `LISTS_TASKS` (`true`: the tab reads 任务) | `ContextPanel` |
| `bot-avatar` | bloub blob | `BotAvatarProps` in `components/slots/bot-avatar-contract.ts` (`id` is the bot's id when the caller has one; `coordinator` is set by `COORDINATOR_AVATAR`) | `BotAvatar`, `CoordinatorAvatar`, `colorFor`, `COORDINATOR_AVATAR` from `@/components/nav/bot-avatar` |
| `chat-message` | today's message rows (`Message`, `Bubble`, `ReplyWaiting`) | `ChatMessageProps`, `ChatWaitingProps` in `components/slots/chat-message-contract.ts`; also exports `CHAT_SURFACE` | `coordinator-chat.tsx`, through `@ui-slot/chat-message` |
| `board` | 看板's column frames, the 已隐藏 lane and the card face; the board, drag and drop, the card's context menu and controls and every save stay shared; not the right-hand panel or the top bar | `BoardColumnFrameProps`, `BoardHiddenLaneProps`, `BoardCardProps` in `components/slots/board-contract.ts`; exports `BoardColumnFrame`, `BoardHiddenLane`, `BoardCard` | `components/blocks/kanban-board-1/components/board-parts.tsx`, through `@ui-slot/board` |
| `chat-composer` | the Grok-style composer (attach and the model chip on the left, send or stop on the right) | `ChatComposerProps` in `components/slots/chat-composer-contract.ts`; what it does comes from `useChatComposer` (`hooks/use-chat-composer.ts`) | `ChatComposer` from `@/components/coordinator/chat-composer` |
| `model-picker` | a bot's model chip and its menu | `BotModelPickerProps` in `components/slots/model-picker-contract.ts`; menu, saves and refresh come from `useBotModelPicker` (`hooks/use-bot-model-picker.ts`) | `BotModelPicker` from `@/components/coordinator/bot-model-picker` |
| `panel-header` | the header row of a bot's 概览 (search, ⤢, ✕) and of a group's panel (详情, ✕) | `PanelHeaderProps` in `components/slots/panel-header-contract.ts` (`actions` are the secondary actions with their labels; `widen` is ⤢, which the group's default does not draw); optional `PANEL_INITIAL_WIDTH` (`(mainWidth) => width`, from the width right of the left sidebar; `null` or missing: 360) sets the right column's default width through `usePanelInitialWidth` (`hooks/use-panel-width.ts`), and a width the person chose still wins | `ContextPanel`, `GroupPanel`; `PANEL_INITIAL_WIDTH` also `RightColumn` |
| `reply-activity` | a reply's thinking and tool calls as Trace rows | `ActivityThinkingProps`, `ActivityToolView`, `ActivityGroupProps` in `components/slots/reply-activity-contract.ts`; exports `ActivityList`, `ActivityThinking`, `ActivityTool`, `ActivityGroup` | `components/coordinator/reply-activity.tsx`, through `@ui-slot/reply-activity` |
| `settings-devices` | 设置 › 设备's page: connected computers and servers, their state and actions; reading, live updates and the add / reconnect dialogs stay shared | `SettingsDevicesProps` in `components/slots/settings-devices-contract.ts`; actions in `app/actions/agents`; `NoRunsLine`, `InstallAgents`, `SandboxBlocked` in `components/devices/devices-list.tsx` | `DevicesSettings` |
| `settings-frame` | app rail and window bar around settings (`AppFrame`) | `SettingsFrameProps` in `components/slots/settings-frame-contract.ts`; optional `OWN_SETTINGS_FRAME` (`false` or missing: settings stay in the workspace frame; `true`: `IssueWorkspace` draws settings in this frame); optional prop `onBack` returns to the app page shown before Settings opened (home when Settings was opened directly) | `SettingsFrame` from `@/components/settings/settings-shell`; `IssueWorkspace` |
| `settings-sidebar` | settings section list | `SettingsSidebarProps` in `components/slots/settings-sidebar-contract.ts` | `SettingsSidebar` from `@/components/settings/settings-sidebar` |
| `settings-connections` | 设置 › 连接's list: connected apps (Composio, GitHub, Linear, Telegram) and custom MCP servers; an app's own page stays shared | `SettingsConnectionsProps` in `components/slots/settings-connections-contract.ts`; actions on `apps` (`useConnectedApps`), `useMcpConnections`, `OwnAppsStatus` | `PluginsView` (section `connections`) |
| `settings-billing` | 设置 › 计费's page: plan, 免费额度, 余额 and 账单记录; reading, the Stripe redirects and the returns from Checkout stay shared | `SettingsBillingProps` in `components/slots/settings-billing-contract.ts`; states and actions from `hooks/settings/use-billing.ts`; `BalanceSection`, `FreeAllowanceSection` in `components/billing/` | `BillingSettings` |
| `settings-content` | heading and card around a section (`AppShellContent variant="settings"`) | `SettingsContentFrameProps` in `components/slots/settings-content-contract.ts` | `SettingsView` |
| `settings-usage` | 设置 › 用量's page: totals, the daily chart and the per-bot / per-member table for a month; reading, month and grouping state and the CSV export stay shared | `SettingsUsageProps` in `components/slots/settings-usage-contract.ts`; `usageRows`, `useUsageDuration` in `components/settings/usage-view.tsx` | `UsageSettings` |
| `settings-account` | 账户 body (picture, name, email, sign-out, delete account) | `SettingsAccountProps` in `components/slots/settings-account-contract.ts` | `AccountSettings` from `@/components/settings/account-settings` |
| `settings-general` | 常规 body (icon, name, address, transfer, delete, archived bots) | `SettingsGeneralProps` in `components/slots/settings-general-contract.ts` | `SettingsView` |
| `settings-memory` | 记忆与建议 body (switch, facts by kind, correct, delete) | `SettingsMemoryProps` in `components/slots/settings-memory-contract.ts` | `MemorySettings` from `@/components/settings/memory-settings` |
| `settings-models` | 模型与订阅 body (subscriptions, API keys, fallback, model order, profiles, sharing) | `SettingsModelsProps` in `components/slots/settings-models-contract.ts` | `SettingsView` |
| `settings-notifications` | 通知 body (push switches, when to push) | `SettingsNotificationsProps` in `components/slots/settings-notifications-contract.ts` | `NotificationSettings` from `@/components/settings/notifications-settings` |
| `settings-preferences` | 偏好设置 body (appearance, language, task prefix, replay onboarding) | `SettingsPreferencesProps` in `components/slots/settings-preferences-contract.ts` | `SettingsView` |
| `settings-privacy` | 数据与隐私 body (data export, shared links) | `SettingsPrivacyProps` in `components/slots/settings-privacy-contract.ts` | `PrivacySettings` from `@/components/settings/privacy-settings` |
| `settings-secrets` | 密钥与登录 / 密钥与环境 body (my secrets and logins, workspace secrets) | `SettingsSecretsProps` in `components/slots/settings-secrets-contract.ts` | `SecretsPage` from `@/components/settings/secrets-page` |
| `settings-security` | 安全 body (password, signed-in devices, Google sign-in) | `SettingsSecurityProps` in `components/slots/settings-security-contract.ts` | `SettingsView` |
| `task-column` | a task open in the right column beside the centre (`?task=`, decision 2026-11-07-2045): its title and threads; the default layer never opens one | `TaskColumnProps` in `components/slots/task-column-contract.ts`; threads from `useIssueThreads`; `openThread`, `closeTask` move between it and its threads | `TaskColumn` from `@/components/workspace/task-column` |
| `task-conversation` | a thread on a task, opened as the task's one conversation (#1681): its attempts oldest first, scrolled to the one opened | `TaskConversationProps` in `components/slots/task-conversation-contract.ts`; no required exports; optional `TaskConversation` (`null` or missing: a thread opens alone), built from `IssueThreadPanel`'s `before`, `focusRunId` and `transcriptOnly` | `ThreadColumn` |
| `thread-card` | a thread a reply dispatched, as a card under that reply | `ThreadCardProps` in `components/slots/thread-card-contract.ts` (`onOpenTask` opens its task for a layer whose card is the task's) | `ThreadCard` from `@/components/coordinator/thread-card` |
| `thread-header` | a thread panel's header row (←, title, where it runs, Artifact, stop, open task, ✕) and the status line above its transcript | `ThreadHeaderProps`, `ThreadStatusLineProps` in `components/slots/thread-header-contract.ts`; the panel passes its widgets and actions, the slot lays them out; optional `widen` is the right column's ⤢ (`useRightColumnWiden`, `components/workspace/right-column-widen.ts`, which a `task-column` layer reads too), `liveRunId`, `status` and `acceptanceTaskId` let a layer list the identity and Artifacts itself, and the status line's `issueId`, `runId`, `harness` let it name the machine and Agent | `ThreadHeader`, `ThreadStatusLine` from `@/components/workspace/thread-header` |

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

## iOS app

The iOS app (`apps/mobile`) has its own slots, filled from the layer's
`mobile/` folder. They are React Native components, so they share nothing with
the web slots but the idea.

| | Open-source build | Official OTA |
| --- | --- | --- |
| `MIKKA_MOBILE_OVERLAY_DIR` | unset | `.hosted-ui/mobile`, relative to the repository root and inside it |
| `@ui-slot/<name>` | `apps/mobile/slots/<name>.tsx` | `$MIKKA_MOBILE_OVERLAY_DIR/slots/<name>.tsx` when the layer has it, else the default |
| `@hosted/*` | does not resolve | `$MIKKA_MOBILE_OVERLAY_DIR/*` |

`apps/mobile/ui-overlay.js` decides this and `apps/mobile/metro.config.js`
applies it as Metro's `resolveRequest`. Every other import in a layer file
resolves as if from `apps/mobile`, so the layer uses the app's `react`,
`react-native`, `react-native-svg` and `react-native-reanimated` and installs
no packages of its own. `@/` in the layer is `apps/mobile` (for example
`@/lib/bot-look`, `@/slots/bot-avatar-contract`). `apps/mobile/tsconfig.json`
maps `@ui-slot/*` to the defaults, so typecheck always sees the open-source
build. A set but missing directory fails the bundle.

| Slot | Default | Props | Callers import |
| --- | --- | --- | --- |
| `bot-avatar` | the still blob with one eye | `BotAvatarProps` in `apps/mobile/slots/bot-avatar-contract.ts` (`color`, `shape`, `size`; `id` and `coordinator` when the caller has them, as on the web); colours and shapes in `apps/mobile/lib/bot-look.ts` | `BotAvatar` from `@/components/icons` |

Required exports are `MOBILE_SLOT_EXPORTS` in `apps/mobile/ui-overlay.js`;
the same rule as the web applies (merge the layer's export first).

`mobile-update.yml` reads the existing `HOSTED_UI_READ_KEY` through the main
OIDC identity on a push to main or a manual run, checks the layer out to
`.hosted-ui` and sets `MIKKA_MOBILE_OVERLAY_DIR` when it has a `mobile/`
folder; without the key or the folder the default slots ship. A push to the
layer's `mobile/` ships by running Mobile OTA update on main by hand. The EAS
native build (`mobile-native.yml`) builds on Expo's servers from the
repository alone, so a fresh binary embeds the default slots until it loads
the production update.

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
