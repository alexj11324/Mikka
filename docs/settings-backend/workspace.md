# 设置 › 工作区：后端

分支 `feat/settings-backend-workspace`。本文写的是已经实现、测试通过的部分（常规、成员、团队、Bot）。用量和计费还没有交付，见文末「未完成」。

## 约定

- 新 action 都用 `workspaceAction`（`lib/workspace-admin/action.ts`）包装，它基于 `runAction`，返回 `ActionResult<T>`：成功时是 `T`，失败时是 `{ error: ActionErrorCode, params? }`。`WorkspaceError(code)` 会变成同名错误码，`code` 不在 `ACTION_ERROR_CODES` 里时变成 `generic`；`ZodError` 变成 `validationGeneric`；其他异常照常抛出。
- 「当前工作区」由 `currentWorkspaceActor()`（`lib/workspace-admin/current.ts`）解析：先取 cookie `mikka-workspace`，没有时取第一个启用中的成员资格。每次写操作都会在事务里用 `requireWorkspace(..., admin = true)` 重新校验管理员身份，并对工作区行加 `FOR UPDATE` 锁。
- 数据分在两个库：`DATABASE_URL` 是工作区库（工作区、成员、邀请、团队、团队任务关联、项目），`MIKKA_DATABASE_URL` 是应用库（Bot、线程 agent_runs、任务 issues、设置、计费表）。两个库不能共用一个事务，所以破坏性操作会先锁住工作区库的行，在应用库的独立事务里删除并先提交，然后再提交工作区库。每一步都是幂等的：工作区库那一步失败时，重试一次就能删完。

## 迁移

| 文件 | 目标库 | 内容 |
|---|---|---|
| `drizzle/20261029213938_workspace_admin_identity.sql` | `DATABASE_URL` | `mikka_workspaces.icon`；新表 `mikka_workspace_slug_redirects(slug PK, workspaceId)` |
| `drizzle/20261029213939_workspace_admin_settings.sql` | `MIKKA_DATABASE_URL` | 新表 `workspace_settings`；`bots` 新增 `model`、`repository`、`monthlyCreditLimit` 列；`bot_subagents` 指向 bots 的外键改成 `ON UPDATE CASCADE`；计费表 `workspace_billing`、`workspace_credit_grants`、`stripe_webhook_events`（已建表，读写逻辑没有交付） |

## 常规

### `updateWorkspace(input)` — `app/actions/workspace-settings.ts`

```ts
updateWorkspace(input: { name?: string; slug?: string; icon?: string | null }): Promise<ActionResult<{ id: string; name: string; slug: string | null; icon: string | null }>>
```

- 权限：当前工作区的管理员。
- `name`：去掉首尾空白后 1–120 个字符。
- `slug`：3–64 位小写字母、数字或 `-`，首尾不能是 `-`。改 slug 时，旧 slug 写进 `mikka_workspace_slug_redirects`；以后打开 `/w/<旧 slug>` 会 308 跳到 `/w/<新 slug>`（只对该工作区的启用成员生效，非成员仍然得到 404，不会泄露新地址）。改回自己以前用过的 slug 时，那条重定向记录会被删掉。所有 slug 修改共用一把 advisory lock。`createWorkspace` 也不能占用别的工作区保留的旧 slug。
- `icon`：`null` 或 `''` 表示清除。只接受 `data:image/(png|jpeg|webp|gif);base64,...`，解码后不超过 200 KB，并且会核对文件头（magic bytes）。不接受 SVG，因为 SVG 里可以带脚本。
- 存储方式：data URL 直接存在 `mikka_workspaces.icon`。原因是仓库里没有对象存储，账户头像也是以 URL 字符串存在 user 行上；不超过 200 KB 的位图对单行来说可以接受，也不需要再接一个服务。
- 错误码：`workspaceAccessDenied`、`workspaceSlugTaken`、`workspaceIconInvalid`、`validationGeneric`。

### `/w/[slug]` 回退 — `app/w/[slug]/route.ts`

按 slug 找不到工作区时，会调用 `resolveSlugRedirect(slug, userId)`（`lib/workspace-admin/general.ts`）查重定向表，找到就 308 跳到当前 slug。

### `deleteWorkspace(id, confirmName)`

```ts
deleteWorkspace(id: string, confirmName: string): Promise<ActionResult<{
  deleted: { bots: number; threads: number; tasks: number; projects: number; teams: number; invitations: number; members: number }
  nextWorkspaceId: string | null
}>>
```

- 权限：该工作区的管理员。
- `confirmName` 去掉首尾空白后必须和工作区名称完全一致（区分大小写），否则返回 `workspaceDeleteNameMismatch`。
- 如果 `workspace_billing.status` 还在 `active / trialing / past_due / unpaid / incomplete` 之一，返回 `workspaceHasActiveSubscription`，要先取消订阅才能删除。
- 删除范围，应用库（一个事务）：
  - 工作区的 Bot（`bots.workspaceId`），以及这些 Bot 的线程（`agent_runs.botId`）。删除 Bot 时会级联删掉它的对话（coordinator_sessions/messages/events）、云桌面、云运行时、计算机运行绑定、agent kit 和后台任务（bot_subagents）。
  - 没有 `ON DELETE CASCADE`、会挡住删除的表要先删：`suggestion_executions`、`thread_machines`（同时按 workspaceId 和 botId 删）。
  - 团队任务：`mikka_team_issues` 里关联的 `issues`（会级联删掉任务上的运行和 Linear 发布）；以及 `team_issue_create_requests`、`team_issue_promotions`。
  - 按 workspaceId 删：`conversations`、`subagent_events`、`cloud_machines`、`workspace_snapshots`、`workspace_computer_policies`、`credential_fill_leases`、`credential_challenges`、`operation_ledger`、`workspace_settings`、`workspace_credit_grants`、`workspace_billing`。
- 删除范围，工作区库（一个事务）：团队任务回执、`mikka_team_issues`、`mikka_team_projects`，只挂在这些团队下的 `workspace_projects` 及其事件，团队成员，团队，邀请，成员，slug 重定向，最后是工作区行本身。
- 不删的数据：成员的账户；个人任务（没有团队关联的 issues）；个人模型订阅（`byos_connections / byos_bindings / byos_*`，虽然这些表上有 workspaceId，也保留）；Linear 连接与同步（`linear_connections`、`linear_team_syncs` 按个人账户归属，没有工作区维度）；GitHub App 安装（`github_repository_installations` 也按个人账户归属）。代码里没有工作区级的 Linear/GitHub 关联，所以这一类没有要删的东西。
- 切换工作区：发起删除的管理员，cookie 会改成他下一个启用中的工作区（`nextWorkspaceId`）；没有其他工作区时 cookie 会被清除，下次访问时 `loadWorkspaceContext` 会自动建一个默认工作区。其他成员的 cookie 还指向已删除的 id，但 `loadWorkspaceContext` 只会在启用中的成员资格里选，所以他们下一次请求会自动落到自己的第一个工作区。
- 错误码：`workspaceAccessDenied`、`workspaceDeleteNameMismatch`、`workspaceHasActiveSubscription`、`validationGeneric`。

## 成员

### `removeWorkspaceMember(memberId, options?)` — `app/actions/workspace-settings.ts`

```ts
removeWorkspaceMember(memberId: string, options?: { transferTo?: string }): Promise<ActionResult<{ removed: true; transferred: { bots: number } }>>
```

- `memberId` 是成员的 user id。权限：当前工作区的管理员。
- 不能移除自己（`workspaceCannotRemoveSelf`，自己退出请用「离开」）；不能移除最后一位启用中的管理员（`workspaceLastAdmin`）。
- 副作用：删除成员行；删除他在本工作区各团队里的成员资格；把同一邮箱下待处理的邀请标记为 revoked。
- 立即失去访问：每个请求都会经过 `requireWorkspace` / `loadWorkspaceContext` 读取成员资格（`loadWorkspaceContext` 的 React cache 只在单次渲染内有效），所以被移除的人下一次请求就会被拒绝或被切到别的工作区。
- 错误码：`workspaceAccessDenied`、`workspaceCannotRemoveSelf`、`workspaceMemberNotFound`、`workspaceLastAdmin`，以及下面「转交」的错误码。

### `updateWorkspaceMember({ ..., transferTo? })` — `app/actions/workspace.ts`

原有签名新增了可选参数 `transferTo`，只能在 `status: 'suspended'` 时传，否则返回 `validationGeneric`。返回格式还是原来的 `{ ok, data | error }`，因为现有组件依赖这个格式，没有改。

### 转交（`transferTo`）— `lib/workspace-admin/members.ts`

- 归属字段：Bot 的归属是 `bots.ownerId`，同时是 `(id, workspaceId, ownerId)` 复合外键的一部分。
- 接手人必须是本工作区里另一位启用中的成员（`workspaceTransferTargetInvalid`）。
- 有未结束的线程（agent_runs 状态是 queued、preparing、running、waiting_input 或 finishing）或者后台任务（bot_subagents 状态是 queued、running 或 needs_you）时，拒绝转交（`botTransferBusy`）。
- 接手人已经有同名 Bot（名称比较不区分大小写）时，拒绝转交（`botTransferNameConflict`）。
- Bot 的 id、对话、线程历史、已结束的后台任务都会保留。和原主人绑定的行会被删除，接手人第一次使用时会重新创建：云桌面 `bot_desktops`、云运行时 `bot_cloud_runtimes`、`computer_run_bindings`。
- agent kit 历史（`agent_kit_*`）在设计上不可变（有触发器拦截 UPDATE），而且它的身份里包含 owner_id，所以转交时会把它删掉，Bot 在新主人名下改用内置定义。
- Linear 同步没有转交。`linear_team_syncs.ownerId` 引用的是个人账户，同步时用的是这个人自己的 Linear OAuth token（`linear_connections`）；它没有工作区维度。如果把归属改给别人，就会用接手人的 token 去操作另一个人连接的 Linear 组织，这个行为不安全，所以没有实现。这里需要产品确认：设计里说的「Linear 同步归属」具体指什么。

## 团队 — `app/actions/teams.ts`

### `getTeamDeletionImpact(teamId)`

```ts
getTeamDeletionImpact(teamId: string): Promise<ActionResult<{ teamId: string; name: string; tasks: number; projects: number }>>
```

### `deleteTeam(teamId, confirmName)`

```ts
deleteTeam(teamId: string, confirmName: string): Promise<ActionResult<{ deleted: { tasks: number; projects: number } }>>
```

- 权限：团队所在工作区的管理员（团队 owner 不行）。
- 任务：`mikka_team_issues` 里还存在的 issues。项目：只挂在这个团队下的项目；同时挂在其他团队下的项目只会断开和这个团队的关联，项目本身保留。
- `confirmName` 必须和团队名称完全一致（`teamDeleteNameMismatch`）。会先在应用库里删任务和建任务 / 提升任务的请求记录，再在工作区库里删回执、关联、项目及事件、团队成员和团队本身；整个过程持有 `lockTeamRelations` 锁。
- 错误码：`teamNotFound`、`workspaceAccessDenied`、`teamDeleteNameMismatch`、`validationGeneric`。

## Bot — `app/actions/bots.ts`

设计见 `docs/design/bot-settings.md`：Bot 属于创建者，管理员只管「允许什么」。原来的 `getWorkspaceBotDefaults` / `updateWorkspaceBotDefaults`（管理员给全工作区设默认模型和默认仓库，#442/#466）已删除。

### `getWorkspaceModelPolicy()`

```ts
getWorkspaceModelPolicy(): Promise<ActionResult<{
  allowedModels: Array<'mikka' | 'codex' | 'claude'> // 可用模型，菜单顺序；从未保存过 = 全部
  startingModel: 'mikka' | 'codex' | 'claude' | null // 新 Bot 的初始模型
  version: number // 乐观锁版本，保存时作为 expectedVersion 传回
  modelGroups: BotModelGroup[]
}>>
```

- 权限：任何启用中的成员都能读（成员的 Bot 菜单来自这里）。

### `updateWorkspaceModelPolicy(input)`

```ts
updateWorkspaceModelPolicy(input: { allowedModels: string[]; startingModel: string | null; expectedVersion?: number }): Promise<ActionResult<ModelPolicy> | ModelPolicyConflict>
```

- 权限：管理员（`requireWorkspace(..., true)` 锁工作区行，串行化）。`allowedModels` 至少一个、不重复；`startingModel` 必须在其中，否则 `botModelNotAllowed`。存在 `workspace_settings."allowedModels"` 和 `"defaultModel"`，数据库 CHECK 同样约束。
- 乐观锁：带 `expectedVersion` 时是对 `"modelPolicyVersion"` 的 compare-and-set；版本过期不写入，返回 `{ error: 'modelPolicyConflict', status: 409, current }`。
- 移出可用模型的模型：不改写任何 Bot 的 `bots.model`；Bot 按 `resolveBotModel` 回落到初始模型，否则第一个允许的模型。

### `getBotSettings({ botId })` / `updateBotSettings({ botId, model?, repository? })`

- 读：工作区任何启用中的成员；返回存储值、实际生效值（`effectiveModel`、`effectiveRepository`）、`modelUnavailable`、`repositoryUnavailable`、可选项（`allowedModels`、`repositories`）、`canEdit`（只有创建者为 true）、`connectedProviders`（创建者在本工作区已连接的 Codex/Claude 订阅；对其他人恒为空）。
- 写：只有 Bot 的创建者，管理员也不行（`botOwnerOnly`）。模型必须在可用模型中（`botModelNotAllowed`），仓库必须被工作区成员安装的 GitHub App 覆盖（`botRepositoryUnavailable`）。写入时对 `workspace_settings` 行加 `FOR SHARE`，与管理员保存可用模型互斥。不传的字段不变，`null` 清除。

### `createBot(input)`

不传 `model` 时用新 Bot 的初始模型（否则第一个允许的模型），`repository` 默认为空。显式传入的值同样校验可用模型和已安装仓库。注意：运行时现在还没有读取 `bots.model`，模型仍然由订阅绑定决定。

### `listWorkspaceBots()`

```ts
listWorkspaceBots(): Promise<ActionResult<{ bots: Array<{
  id; name; color; shape; ownerId; ownerName: string | null; model; repository
  status: 'idle' | 'running'; runningThreads: number
}> }>>
```

- 权限：任何启用中的成员都能读。`runningThreads` 是这个 Bot 未结束的线程数（状态是 queued、preparing、running、waiting_input 或 finishing）。界面上显示为「空闲」，或者「运行中 · N 个线程」。

## 新增错误码（`lib/action-result.ts`，`messages/*.json` 的 `Errors` 下）

`workspaceSlugTaken`、`workspaceIconInvalid`、`workspaceDeleteNameMismatch`、`workspaceHasActiveSubscription`、`workspaceCannotRemoveSelf`、`workspaceTransferTargetInvalid`、`botTransferBusy`、`botTransferNameConflict`、`teamNotFound`、`teamDeleteNameMismatch`、`botRepositoryUnavailable`、`botModelNotAllowed`、`botOwnerOnly`、`modelPolicyConflict`。以下几个已经加好错误码和文案，但对应功能没有交付：`usageLimitReached`、`usageCreditsExhausted`、`billingNotConfigured`、`billingNoSubscription`、`billingPlanInvalid`、`billingProviderFailed`。

## 测试

- `test:workspace-settings`：`tests/workspace-settings-actions.test.ts`（action 包装：调用身份、当前工作区、错误码映射、cookie 切换、createBot 默认值），`lib/workspace-admin/icon.test.ts`。
- `test:workspace-admin-db`：`tests/workspace-admin.db.test.ts`，在真实 PostgreSQL 上跑。每个破坏性用例都会额外建一个工作区，并断言它的数据没有被动到。这个 suite 已经登记到 `scripts/run-db-tests.mjs` 的 REQUIRED_SUITES 和 CI 的 `DB_TEST_EXPECTED`。

## 未完成

- 5 用量：调研和代码草稿已经写了一部分，没有测试，所以没有提交。可以计量的真实数据有这些：Bot 线程的时长（agent_runs.startedAt / finishedAt，按 botId 归到工作区）、云电脑运行（computer_run_bindings）、后台任务次数（bot_subagents）。模型 token 用量方面，只有 `proactive_usage` 按个人和天记录了 token，没有工作区维度，单次运行也没有 token 数，所以点数口径只能按时长和次数定。派发入口有四处需要加检查：`lib/run-dispatch.ts`（insertRunOnce）、`lib/run-admission-store.ts`、`lib/computer/queue-run.ts`、`lib/cloud-computer/subagents.ts`（create）。
- 6 计费（Stripe）：只建了表，没有实现。
