# UI slots

There is one UI ([decision 2026-11-08-2133](design/decisions/2026-11-08-2133-one-ui.md)).
Its code lives in this repository and in the private `alexj11324/mikka-hosted-ui`.
Slots are how official web and desktop builds bring the private code in
([decision 2026-11-06-2000](design/decisions/2026-11-06-2000-hosted-ui-overlay.md)).
Paid component source (BoardUI Pro, affectUI, beUI Pro) lives only in
`mikka-hosted-ui`; this repository never imports it. The build pipeline that
checks the private repository out is issue #1527.

Slots are a mechanism, not a requirement: fix a page where its code lives,
and don't add a slot only to make a fix possible. The build without
`mikka-hosted-ui` only has to compile.

## Renderer source selection

| | Build without `mikka-hosted-ui` (compile only) | Official build |
| --- | --- | --- |
| `MIKKA_UI_OVERLAY_DIR` | unset | path of the `mikka-hosted-ui` checkout, inside this repository (CI uses `.hosted-ui/`, which is gitignored) |
| `@ui-slot/<name>` | `components/slots/<name>.tsx` | `$MIKKA_UI_OVERLAY_DIR/slots/<name>.tsx` for every required provider. Only `auth-sso`, `settings-governance` and `settings-organization` can use their public no-content contracts |
| `@hosted/*` | does not resolve | `$MIKKA_UI_OVERLAY_DIR/*` |

`lib/ui-overlay.mjs` decides this once. The shared Vite plugin
(`apps/frontend/scripts/application-plugin.mjs`) applies it to both Web and
desktop renderer builds; it is the only place the mapping is applied.
Production uses the [shared frontend/API runtime](operations/web-runtime.md).
`tsconfig.json` maps `@ui-slot/*` to the defaults, so typecheck, lint and tests
in this repository always see the build without `mikka-hosted-ui`. The layer must sit inside
the repository, as `uiOverlay()` enforces, and resolves `react` and this app's modules from this repository's `node_modules`.
A missing directory, or one outside the repository, fails the build.

## Slots

| Slot | Surface | Props | Callers import |
| --- | --- | --- | --- |
| `app-frame` | 外框: the app window around every page (frame, window bar slot, the rounded card) and the icon rail; the window bar's content, the pages and the right-hand panel are not part of it | `AppFrameProps`, `IconRailProps` in `components/slots/app-frame-contract.ts`; `RAIL_ITEMS` in `components/nav/rail-items.ts`; `UpdateButton` in `components/nav/icon-rail-view.tsx`; `SETTINGS_COLORS` in `components/app-frame-view.tsx`; `FRAME_LISTS_CHATS`, `FRAME_OWNS_PANEL` (the chat's Overview and the browser are tabs of the conversation's work area, `ThreadScreenProps.panels`) and `FRAME_OWNS_HEADER` (the window bar keeps only ← →; the waiting count arrives as `RailProps.inboxCount`) | `AppFrame` from `@/components/app-shell`, `IconRail` from `@/components/nav/icon-rail` |
| `artifacts` | the Artifact page's body (the library: categories and the table) | `ArtifactsPageProps` in `components/slots/artifacts-contract.ts` (the workspace's tasks, to name folders) | `IssueWorkspace`, through `@ui-slot/artifacts` |
| `inbox` | 收件箱 and its suggestion feed | `InboxPageProps` in `components/slots/inbox-contract.ts` (the live threads and tasks, opening a task, 连接应用); suggestions from `useSuggestions` | `IssueWorkspace`, through `@ui-slot/inbox` |
| `tasks` | 任务 page at `?section=tasks` | `TasksPageProps` in `components/slots/tasks-contract.ts` (the live threads and tasks, opening a task, 新建任务, 收件箱) | `IssueWorkspace`, through `@ui-slot/tasks` |
| `new-task` | 新建任务 dialog | `NewTaskProps` in `components/slots/new-task-contract.ts` (the request and its files, the machines with their icons, the Bots to hand to, the Agent 配置 choices from `useTaskProfileChoices`, notices, sending); exports `NewTask`, shown while the dialog is open; E2B Key's dialog stays Mikka's | `NewTaskDialog` |
| `new-bot` | 新建 Bot dialog | `NewBotProps` in `components/slots/new-bot-contract.ts` (the name, colour and shape, saving, create); exports `NewBot`, shown while the dialog is open | `NewBotDialog` |
| `memory` | 记忆 page at `?section=memory` | `MemoryPageProps` in `components/slots/memory-contract.ts` (nothing: reads and saves come from `hooks/settings/use-memory-settings.ts`) | `IssueWorkspace`, through `@ui-slot/memory` |
| `all-threads` | 全部线程's window-bar button and the right column it opens | `AllThreadsToggleProps`, `AllThreadsColumnProps` in `components/slots/all-threads-contract.ts` (`pending` is the 待处理 task count for a layer that lists tasks) | `AllThreadsToggle`, `AllThreadsColumn` from `@/components/nav/all-threads` |
| `bot-tasks` | the bot panel's 线程 tab: the threads it dispatched in R-52's groups | `BotTasksProps` in `components/slots/bot-tasks-contract.ts`; tasks from `tasksOf` (`hooks/use-bot-tasks.ts`); `LISTS_TASKS` (`true`: the tab reads 任务) | `ContextPanel` |
| `bot-overview` | Bot overview with details, tasks, pull requests and devices | `BotOverviewProps` in `components/slots/bot-overview-contract.ts` (the tabs and search, rename and look saves, the public role, routines and library, the bot-tasks list rendered, PR rows, the computer's key state and screen, Mikka's dialogs); exports `BotOverview`. Used only where 概览 is a tab of the conversation's work area (`FRAME_OWNS_PANEL`); reads and saves come from `components/nav/bot-overview.tsx` | `ContextPanel` |
| `bot-avatar` | bloub blob | `BotAvatarProps` in `components/slots/bot-avatar-contract.ts` (`id` is the bot's id when the caller has one; `coordinator` is set by `COORDINATOR_AVATAR`) | `BotAvatar`, `CoordinatorAvatar`, `colorFor`, `COORDINATOR_AVATAR` from `@/components/nav/bot-avatar` |
| `chat-message` | today's message rows (`Message`, `Bubble`, `ReplyWaiting`) | `ChatMessageProps`, `ChatWaitingProps` in `components/slots/chat-message-contract.ts`; also exports `CHAT_SURFACE` | `coordinator-chat.tsx`, through `@ui-slot/chat-message` |
| `board` | 看板's column frames, the 已隐藏 lane and the card face; the board, drag and drop, the card's context menu and controls and every save stay shared; not the right-hand panel or the top bar | `BoardColumnFrameProps`, `BoardHiddenLaneProps`, `BoardCardProps` in `components/slots/board-contract.ts`; exports `BoardColumnFrame`, `BoardHiddenLane`, `BoardCard`; `BoardScreen` (`BoardScreenProps`): the whole page under the top bar (toolbar, columns, list) from BoardPage's filters, 显示 options, scope and view, with `useIssueBoardSaves` behind drops and Mikka's `TaskContextMenu` around each card; the Coordinator sidebar stays BoardPage's | `components/blocks/kanban-board-1/components/board-parts.tsx`, through `@ui-slot/board`; `BoardPage` supplies the screen props |
| `chat-composer` | the Grok-style composer (attach and the model chip on the left, send or stop on the right) | `ChatComposerProps` in `components/slots/chat-composer-contract.ts`; what it does comes from `useChatComposer` (`hooks/use-chat-composer.ts`) | `ChatComposer` from `@/components/coordinator/chat-composer` |
| `model-picker` | a bot's model chip and its menu | `BotModelPickerProps` in `components/slots/model-picker-contract.ts`; menu, saves and refresh come from `useBotModelPicker` (`hooks/use-bot-model-picker.ts`) | `BotModelPicker` from `@/components/coordinator/bot-model-picker` |
| `panel-header` | the header row of a bot's 概览 (search, ⤢, ✕) and of a group's panel (详情, ✕) | `PanelHeaderProps` in `components/slots/panel-header-contract.ts` (`actions` are the secondary actions with their labels; `widen` is ⤢, which the group's default does not draw); `PANEL_INITIAL_WIDTH` (`(mainWidth) => width`, from the width right of the left sidebar; `null` selects 360) sets the right column's default width through `usePanelInitialWidth` (`hooks/use-panel-width.ts`), and a width the person chose still wins | `ContextPanel`, `GroupPanel`; `PANEL_INITIAL_WIDTH` also `RightColumn` |
| `plugins` | 插件 store and app details | `PluginsPageProps` in `components/slots/plugins-contract.ts` (nothing); exports `PluginsPage`. Reads, the URL (`&app=`, `&category=`) and actions come from `usePluginsView`, `usePluginStore` and `useSkillsSearch`; an app's own page is the shared `PluginAppPage` (all in `components/plugins/plugins-view.tsx`), which a layer draws through `settings-connections`' `AppPage` | `IssueWorkspace`, through `@ui-slot/plugins` |
| `reply-activity` | a reply's thinking and tool calls as Trace rows | `ActivityThinkingProps`, `ActivityToolView`, `ActivityGroupProps` in `components/slots/reply-activity-contract.ts`; exports `ActivityList`, `ActivityThinking`, `ActivityTool`, `ActivityGroup` | `components/coordinator/reply-activity.tsx`, through `@ui-slot/reply-activity` |
| `review-page` | Review for the selected task | `ReviewPageProps` in `components/slots/review-page-contract.ts` (`taskId`, `onClose`); reads and actions from `hooks/code-review/` (`useReviewDiff`, `useReviewFile`, `useReviewChecks`, `useSendToAgent`, `useMergeReview`) over the typed adapter `lib/code-review/client.ts` and the contract `lib/code-review/contract.ts` (#1722, #1732); Esc and ✕ call `onClose` | `IssueWorkspace` mounts it once while `useReviewPage` (`hooks/code-review/use-review-page.ts`) has a task open |
| `review-summary` | Coding task summary | `ReviewSummaryLineProps` in `components/slots/review-summary-contract.ts` (`placement` is `card`, `waiting` or `panel`; `onOpenReview` opens the review page); data from `useReviewSummary`, words from `formatReviewSummary` (`lib/code-review/summary-text.ts`); `REVIEW_ENABLED` (`true`: ⌘⇧B opens the current task's review page and ⌘K lists 「审阅 #N」) | the default `thread-card` slot, `ThreadList`'s 等待你 rows; a layer's `task-column` draws it under the title |
| `search` | ⌘K's palette (`GlobalSearch`): bots, conversations, group chats, tasks, threads, projects and the quick actions, with 加载更多 per source, the status line, nothing-matches and a failed source's 重试 | `SearchPaletteProps` in `components/slots/search-contract.ts` (open state, the query and the sections as data; a row's `select` does what picking it does); reading, filtering and paging stay in `GlobalSearch` over `useSiteSearch` (`hooks/use-site-search.ts`); exports `SearchPalette` | `GlobalSearch` from `@/components/nav/global-search`, through `@ui-slot/search` |
| `settings-devices` | 设置 › 设备's page: connected computers and servers, their state and actions; reading, live updates and the add / reconnect dialogs stay shared | `SettingsDevicesProps` in `components/slots/settings-devices-contract.ts`; actions in `app/actions/agents`; `NoRunsLine`, `InstallAgents`, `SandboxBlocked` in `components/devices/devices-list.tsx` | `DevicesSettings` |
| `settings-frame` | app rail and window bar around settings (`AppFrame`) | `SettingsFrameProps` in `components/slots/settings-frame-contract.ts`; `OWN_SETTINGS_FRAME` (`false`: settings stay in the workspace frame; `true`: `IssueWorkspace` draws settings in this frame); optional prop `onBack` returns to the app page shown before Settings opened (home when Settings was opened directly) | `SettingsFrame` from `@/components/settings/settings-shell`; `IssueWorkspace` |
| `settings-sidebar` | settings section list | `SettingsSidebarProps` in `components/slots/settings-sidebar-contract.ts` | `SettingsSidebar` from `@/components/settings/settings-sidebar` |
| `onboarding` | The first-run guide, whole: a layer draws its own over the same APIs (createBot, 模型订阅's rows, the E2B key through `saveKey`, connected apps, completeOnboarding), keeps everything the guide does, and hands `onDone` the Bot whose chat opens next | `OnboardingProps` in `components/slots/onboarding-contract.ts`; exports `Onboarding` | `components/onboarding/onboarding.tsx` (today's conversation with the first Bot), through `@ui-slot/onboarding` |
| `settings-bot-permissions` | 设置 › 应用与运行权限: the current workspace's access level per connected app (allow / ask / deny, or the Decision API default), the provider's real tool catalogue, the workspace's run permissions and approval mode; this authorizes the workspace, not one Bot; every Bot in the workspace inherits the one choice | `SettingsBotPermissionsProps` in `components/slots/settings-bot-permissions-contract.ts` (read and saved through `/api/bots/:botId/definition` `workspace_write_policy` / `set_workspace_write_policy`, the read-only `/api/bots/:botId/app-tools`, and `/api/agent-cli-policy` `readAgent` / `setAgent` target `workspace`; only admins save); exports `BotPermissionsPage` | `components/settings/bot-permissions.tsx`, through `@ui-slot/settings-bot-permissions` |
| `settings-connections` | 设置 › 连接's list: connected apps (Composio, GitHub, Linear, Telegram) and custom MCP servers | `SettingsConnectionsProps` in `components/slots/settings-connections-contract.ts`; actions on `apps` (`useConnectedApps`), `useMcpConnections`, `OwnAppsStatus`. `AppPage` (`AppPageProps`): an app's own page (`&app=`) on 插件 and 设置 › 连接, reading and acting through `useConnectedAppPage` (`components/plugins/connected-apps.tsx`), `useGitHubPlugin`, `useRepositoryVerification` (`github-settings.tsx`), `useGitHubAppSetup` (`github-app-settings.tsx`), `useLinearPlugin` and `useTelegramPlugin` (`components/settings/`) | `PluginsView` (section `connections`); `AppPage` through `PluginAppPage` |
| `settings-billing` | 设置 › 计费's page: plan, 免费额度, 余额 and 账单记录; reading, the Stripe redirects and the returns from Checkout stay shared | `SettingsBillingProps` in `components/slots/settings-billing-contract.ts`; states and actions from `hooks/settings/use-billing.ts`; `BalanceSection`, `FreeAllowanceSection` in `components/billing/` | `BillingSettings` |
| `settings-content` | heading and card around a section (`AppShellContent variant="settings"`) | `SettingsContentFrameProps` in `components/slots/settings-content-contract.ts` | `SettingsView` |
| `settings-usage` | 设置 › 用量's page: totals, the daily chart and the per-bot / per-member table for a month; reading, month and grouping state and the CSV export stay shared | `SettingsUsageProps` in `components/slots/settings-usage-contract.ts`; `usageRows`, `useUsageDuration` in `components/settings/usage-view.tsx` | `UsageSettings` |
| `settings-account` | 账户 body (picture, name, email, sign-out, delete account) | `SettingsAccountProps` in `components/slots/settings-account-contract.ts` | `AccountSettings` from `@/components/settings/account-settings` |
| `settings-audit` | 设置 › 审计日志, filters, paging and CSV export | `SettingsAuditProps` in `components/slots/settings-audit-contract.ts`: everything `useAuditLog` (`hooks/settings/use-audit-log.ts`) returns – the pages, the 全部 / 安全 filter, the categories and period a layer may narrow to (the read and the CSV export take them), the words for each event, the error with its code, 加载更多 and the export's address; exports `AuditLogPage`. Members are told the page is for admins before anything is read (`SettingsView`) | `AuditLogSettings` |
| `settings-general` | 常规 body (icon, name, address, transfer, delete, archived bots) | `SettingsGeneralProps` in `components/slots/settings-general-contract.ts` | `SettingsView` |
| `settings-governance` | Team Free / Pro: plan and seats on 成员, team usage report on 用量, approval templates on 团队权限 | `SettingsGovernanceProps` in `components/slots/settings-governance-contract.ts`; hooks in `hooks/settings/use-workspace-governance.ts` | `SettingsView` (public no-content contract) |
| `settings-members` | 设置 › 成员 and 设置 › 团队 | `SettingsMembersProps` in `components/slots/settings-members-contract.ts` (the section, the workspace, `inviteInitially`, `onSection` for the page's two tabs); `MembersScreen` draws both sections as one page. Reads and saves come from `useWorkspaceMembers`, `useInviteMembers` (`hooks/settings/use-workspace-members.ts`, `use-invite-members.ts`) and `useTeamDirectory`, `useTeamForm`, `useTeamMembers` (`hooks/settings/use-team-directory.ts`, which also reads `&team=`, `&view=`, `&create=1` and offers 删除团队 to admins) | `SettingsView` |
| `settings-organization` | Enterprise: the 组织 section (Organization, sign-in and SCIM, resource policy and approvals, Organization audit); `ORGANIZATION_SETTINGS` puts it in the sidebar | `SettingsOrganizationProps` in `components/slots/settings-organization-contract.ts`; hooks in `hooks/settings/use-organization.ts` | `SettingsView`, `SettingsSidebar` (public no-content contract) |
| `auth-sso` | Enterprise: company SSO entry on the sign-in page (web sign-in only) | `AuthSsoProps` in `components/slots/auth-sso-contract.ts`; `signInWithSso` in `hooks/settings/use-organization.ts` | `SignInCard` via `AuthForm` (public no-content contract) |
| `settings-memory` | 记忆与建议 body (switch, facts by kind, correct, delete) | `SettingsMemoryProps` in `components/slots/settings-memory-contract.ts` | `MemorySettings` from `@/components/settings/memory-settings` |
| `settings-models` | 模型与订阅 body (subscriptions, API keys, fallback, model order, profiles, sharing) | `SettingsModelsProps` in `components/slots/settings-models-contract.ts` | `SettingsView` |
| `settings-notifications` | 通知 body (push switches, when to push) | `SettingsNotificationsProps` in `components/slots/settings-notifications-contract.ts` | `NotificationSettings` from `@/components/settings/notifications-settings` |
| `settings-permissions` | 设置 › 团队权限 | `SettingsPermissionsProps` in `components/slots/settings-permissions-contract.ts`: each policy's state, save, pending and errors from `useComputerPolicy`, `useSharePolicy`, `useAppPolicy` (`hooks/settings/use-team-permissions.ts`); members get `canEdit: false`; exports `TeamPermissionsPage` | `TeamPermissionsSettings` |
| `settings-preferences` | 偏好设置 body (appearance, language, task prefix, replay onboarding) | `SettingsPreferencesProps` in `components/slots/settings-preferences-contract.ts` | `SettingsView` |
| `settings-privacy` | 数据与隐私 body (data export, shared links) | `SettingsPrivacyProps` in `components/slots/settings-privacy-contract.ts` | `PrivacySettings` from `@/components/settings/privacy-settings` |
| `settings-secrets` | 密钥与登录 / 密钥与环境 body (my secrets and logins, workspace secrets) | `SettingsSecretsProps` in `components/slots/settings-secrets-contract.ts` | `SecretsPage` from `@/components/settings/secrets-page` |
| `settings-security` | 安全 body (password, signed-in devices, Google sign-in) | `SettingsSecurityProps` in `components/slots/settings-security-contract.ts` | `SettingsView` |
| `task-column` | a task open in the right column beside the centre (`?task=`, decision 2026-11-07-2045): its title and threads | `TaskColumnProps` in `components/slots/task-column-contract.ts`; threads from `useIssueThreads`; `openThread`, `closeTask` move between it and its threads | `TaskColumn` from `@/components/workspace/task-column` |
| `task-conversation` | a thread on a task, opened as the task's one conversation (#1681): its attempts oldest first, scrolled to the one opened | `TaskConversationProps` in `components/slots/task-conversation-contract.ts`; exports `TaskConversation`, built from `IssueThreadPanel`'s `before`, `focusRunId` and `transcriptOnly` | `ThreadColumn` |
| `task-detail` | a task's whole page (`?issue=`): bar with origin, ID, star, save state, previous / next, ⋯ and close; title, description, sub-tasks and activity; details beside them or an open thread in their place | `TaskDetailFrameProps` in `components/slots/task-detail-contract.ts`; exports `TaskDetailFrame`. Values, menus and actions come as data (`components/workspace/task-detail-frame.tsx`); the description editor, 验收, an open thread and the dialogs come rendered | `TaskDetail` |
| `thread` | Full Coordinator, Bot or run conversation | `ThreadScreenProps` in `components/slots/thread-contract.ts` (the chat's rows as data and Mikka-rendered nodes, the composer's props for `useChatComposer`, notices, Factory questions from `useFactoryQuestions` in `hooks/use-factory-questions.ts`); exports `ThreadScreen`; `panels`, the page's work-area tabs when the frame owns the panel | `CoordinatorChat`, outside the reader and compact views; `IssueThreadPanel` for a thread outside the Artifact window, where a task's conversation passes its earlier attempts' rows (`collect`, `beforeEntries`) and each entry names its Agent (`author`) |
| `thread-card` | a thread a reply dispatched, as a card under that reply | `ThreadCardProps` in `components/slots/thread-card-contract.ts` (`onOpenTask` opens its task for a layer whose card is the task's) | `ThreadCard` from `@/components/coordinator/thread-card` |
| `thread-header` | a thread panel's header row (←, title, where it runs, Artifact, stop, open task, ✕) and the status line above its transcript | `ThreadHeaderProps`, `ThreadStatusLineProps` in `components/slots/thread-header-contract.ts`; the panel passes its widgets and actions, the slot lays them out; optional `widen` is the right column's ⤢ (`useRightColumnWiden`, `components/workspace/right-column-widen.ts`, which a `task-column` layer reads too), `liveRunId`, `status` and `acceptanceTaskId` let a layer list the identity and Artifacts itself, and the status line's `issueId`, `runId`, `harness` let it name the machine and Agent | `ThreadHeader`, `ThreadStatusLine` from `@/components/workspace/thread-header` |

A slot changes how something looks, never what it does. Data, state and
behaviour stay in this repository and reach the slot as props. A layer slot
exports the same named component as the default, takes the same props and is
a client component (`'use client'`).

**Required exports.** Web and Desktop link the runtime names in `UI_SLOT_EXPORTS` against each selected provider. The production entry links every registered binding, including lazy features. A missing export fails compilation. An unused provider contributes no runtime initialization or output through this check. Publish a provider that exports a new business component before requiring its name in the public contract. CI can test the positive and negative linking cases with synthetic slots. Forks need no private source for those tests.

The settings slots are filled together: a layer's frame draws the whole settings page, and its sidebar and content slots hand it their section list and title rather than drawing their own.

When a new provider is needed, define its shared props and commands in this
repository. Add the runtime exports in the private layer while the current public
revision still works, then register and require them in `UI_SLOT_EXPORTS`.
Record the caller and contract here and verify both revisions together.

## iOS app

The iOS app (`apps/mobile`) has its own slots, filled from the layer's
`mobile/` folder. They are React Native components, so they share nothing with
the web slots but the idea.

| | Build without `mikka-hosted-ui` | Official OTA |
| --- | --- | --- |
| `MIKKA_MOBILE_OVERLAY_DIR` | unset | `.hosted-ui/mobile`, relative to the repository root and inside it |
| `@ui-slot/<name>` | `apps/mobile/slots/<name>.tsx` | `$MIKKA_MOBILE_OVERLAY_DIR/slots/<name>.tsx` (required in a configured layer) |
| `@hosted/*` | does not resolve | `$MIKKA_MOBILE_OVERLAY_DIR/*` |

`apps/mobile/ui-overlay.js` decides this and `apps/mobile/metro.config.js`
applies it as Metro's `resolveRequest`. Every other import in a layer file
resolves as if from `apps/mobile`, so the layer uses the app's `react`,
`react-native`, `react-native-svg` and `react-native-reanimated` and installs
no packages of its own. `@/` in the layer is `apps/mobile` (for example
`@/lib/bot-look`, `@/slots/bot-avatar-contract`). `apps/mobile/tsconfig.json`
maps `@ui-slot/*` to the defaults, so typecheck always sees the open-source
build. A set but missing directory fails the bundle.

| Slot | Surface | Props | Callers import |
| --- | --- | --- | --- |
| `bot-avatar` | the still blob with one eye | `BotAvatarProps` in `apps/mobile/slots/bot-avatar-contract.ts` (`color`, `shape`, `size`; `id` and `coordinator` when the caller has them, as on the web); colours and shapes in `apps/mobile/lib/bot-look.ts` | `BotAvatar` from `@/components/icons` |

Required exports are `MOBILE_SLOT_EXPORTS` in `apps/mobile/ui-overlay.js`;
the same rule as the web applies (merge the layer's export first).

`mobile-update.yml` obtains the production Expo and UI-checkout credentials through the trusted main workflow. A production OTA requires the private mobile folder and its native slots. The native TestFlight workflow selects a reviewed overlay revision for its hosted production build. The public native source and contract tests can run without private credentials.

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
  Paid blocks in the layer keep their shipped look and only data and text
  change ([2026-11-09-0050](design/decisions/2026-11-09-0050-paid-blocks-as-shipped.md)). Because the
  shadcn token block is left out, affectUI blocks currently resolve shadcn
  token names to this app's values; that is recorded drift, not a rule to
  follow.
- **Dependencies.** Packages BoardUI needs that this repository lacks are
  installed in the layer. `react` and `react-dom` come from this repository
  only.
- **Source maps.** No public output of an official build may carry the
  layer's source (issue #1527, item 5).
