# Capy 对齐 · 前后端实现计划

## Context
Figma 对照稿（文件 zPe5LKycb2XuT1ivCLRw07，页 1235:2 第 05–26 节，页 1199:2）和后端缺口清单（本 worktree `tasks/capy-alignment-backend-gaps.md`）都已确认。Alex 要求：用付费组件库实现，前后端一起做，按工作包开并行会话。

已定的规则：
- Bot = Capy 的 Captain。Bot 跑 EVE，所以**不做** Promote/Demote。
- 仓库、setup、变量、secrets 归 **Environment**，参考 Claude Code 的 cloud environment，不叫 Project，**不做网络限制**。
- 新建任务**只登记**。指派给 Bot 会唤醒它，由 Bot 决定是否派发。
- Bot 右键菜单保留 Mikka 独有的 4 项。
- UI 文案一律写 thread / 线程，不写 conversation（AGENTS.md）。

本轮新确认：
- **Needs you / Waiting 和 Capy 保持一致。** Capy 0.9.2 源码里有 `features/settings/issue-states-page.tsx`、`issue-state-editor.tsx`（New state、Icon and color、MoveAndDelete）。状态是组织自定义的，类型分 open / closed，各有一个默认值；删除状态时要把它下面的任务迁到别的状态。Mikka 做工作区自定义状态。
- **范围包含**：Runs as + Slack 以本人身份发帖、PR 详情页 + 按 PR 合并。
- **触发器先不做**：Sentry、GitHub 新事件、多条定时都推后；Templates 网格不放 Sentry 卡。
- **Drive 和 Agent / Bot 互通要做，只做后端和 API**（S7）。

## 组件库落点（R-90、paid-blocks-as-shipped）
- 已经在 `.hosted-ui` slot 里的界面，继续用原来的付费组件：
  - 看板、任务详情、新建任务、Bot 侧栏、新建 Bot、Bot 详情：affectUI。
  - PR 审阅页：BoardUI Pro。
- 目前只在公开仓库、没有 slot 的界面：Automations、PR 目录、Environments 设置。
  - 按 Alex 的要求，新增 `@ui-slot/*` 契约（`components/slots/*-contract.ts`），把它们的付费实现放进 `.hosted-ui/slots/`。
  - 公开仓库保留可编译的默认版。
  - 这一条偏离了 AGENTS.md「不要为修复而加 slot」，依据是 Alex 本次的明确指示。会写进决策文件。
- 付费源码只进 `.hosted-ui`。

## 工作包（每包一个会话 / worktree；公开仓库与 hosted-ui 各开 PR，完成后推送并开 PR）

**S1 自定义状态 + 任务列表**（先 A 后 C，stacked PR）
- A：
  - 迁移：新表 `workspace_issue_states`（name、icon、color、type open|closed、is_default、position、category）。
  - 为每个工作区回填 7 个内置状态，`issues.state_id` 回填。内置状态**不含** Needs you / Waiting：和 Capy 一样，它们是 Agent 运行态（Needs you = 等人处理：提问、审批、审 PR；Waiting = 等外部：CI、设备上线、额度、被别的任务挡住），继续由 `lib/task-state.ts` 推算，显示在行上；工作区想把它们当手动状态用，可以自己在 Issue states 里新建。
  - `task-status-advance.ts` / `run-completion.ts` 的自动推进按 category 落到对应状态。
  - 设置页 Issue states。
  - 状态选择器：Open / Closed 分组，数字键直选。
  - 起点：`lib/issue-meta.ts`、`drizzle/20261029044015_issue_status_codes.sql`、`lib/task-state.ts`。
- C：
  - 视图页签 For you / Assigned to me / Created by me / Mentioned / All。
  - 服务端筛选（`taskListPageInput` 加 assignee / creator / label / due / hasPr / relation / subscribed / hideClosedChildren / match，并加 jsonb 索引）。
  - 订阅通知：`task_subscriptions`。
  - 任务已读未读：`task_reads`。
  - 提及：`task_mentions`。
  - 行右键菜单补齐。
  - 显示设置：Grouping / Direction / Sub-tasks。
  - 文件：`components/workspace/board-page.tsx`、`kanban-board.tsx`、H 的 `slots/board.tsx`、`lib/task-list-page.ts`。

**S2 新建任务 + 指派唤醒 + Start work**
- `createOnlyCommand` 加 assignee（user|bot）、dueDate、labels、visibility、files。
- 新增任务听写接口，复用 `lib/chat-attachments/transcribe.ts`。
- `assignee_changed`、评论、@ 提及写进被指派 Bot 的线程并唤醒它，对应 Capy 的 `issue_activity`。
- 弹窗改成 Capy 的形态，Bot / Machine / Agent 选择移到任务详情的「Start work」。
- 文件：`components/coordinator/new-task-dialog.tsx`、H 的 `slots/new-task.tsx`、`lib/task-create-command.ts`、H 的 `slots/task-detail.tsx`。

**S3 PR 目录 + 详情 + 合并 + 保存视图**
- 筛选：since / projectId / bot。
- 关联模式补 author / createdAt / head，Copy branch 才有值。
- 迁移：`pull_pins`。
- 迁移：`saved_views(scope, filters)`，供 S4 复用。
- 新增 PR 详情路由（Open in new tab）。
- 按 PR 合并的 API，复用 `lib/factory/merge.ts` 的 `githubMergeApi`。
- PR 目录新增 hosted-ui slot。

**S4 Automations 列表 / 新建 / View runs**
- 列表：
  - 页签 My / All / Scheduled，`scheduleListInput` 加 owner / trigger 参数。
  - Creator 筛选、Active 分组、`owner_image`、Templates 网格（只放现有模板，不放 Sentry 卡）。
- 新建对话框：三个选项。
- View runs：
  - 迁移：`source_schedule_id`，派发时写入，并回填历史数据。
  - 线程目录支持 `automation=<id>` 筛选，Save view 用 S3 的 `saved_views`。
- 新增 automations 页 slot。
- 文件：`automations-page.tsx`、`conversation-directory.tsx`、`lib/schedules/store.ts`（list）。

**S5 Automations 编辑器 + Runs as**（stacked：E2 → G；触发器 F 本轮不做）
- E2：
  - `definition` 加 description、environmentId（单选）、runs-in 指定已有线程（singleThreadId）、model + effort、machineSize、runs.{pin, folder, tags}。
  - `MACHINE_SIZES` 加 4c/16G 一档；`workspace_environments.default_machine_size`（迁移）；Environments 设置页加这个字段。
  - ⋯ 菜单：Run now / Duplicate to › / Delete。duplicate 命令支持跨工作区，在目标端重新校验。
  - 编辑器 slot。
- F（触发器）**本轮不做**（Alex 2026-11-19）：GitHub 新事件、comment 拆分、多条定时 `timings[]`、Sentry 集成都留到以后；编辑器里的 Triggers 区和 Add trigger 菜单保持现有能力。
- G：
  - 迁移：`user_schedules.run_as_user_id`，加授权规则；dispatch / validate / 计费改用它。
  - Slack 用 `chat:write.customize` 以 run-as 用户的名字和头像发帖。
  - `notify.slack.quiet`。
- 文件：`lib/schedules/contract.ts`、`runtime.ts`、`automation-editor.tsx`、`lib/slack/automation-notice.ts`。

**S6 Bot 设置**
- 迁移：
  - `bots.environment_id`：`bots.repository` 下线，数据迁进 Environment。
  - `bots.alias`，加 Slack 路由。
  - `bots.crew_target`，与默认 Agent / Profile 放在一起。
  - Bot 自己的运行位置。
  - 成员 / 订阅 / 可见性表。
- 模型选择加 effort。
- 侧栏菜单：Share / Move to。
- New Bot 弹窗、Profile 改成 Figma 23–26 节的样子。
- 文件：`lib/db/schema.ts`（bots）、`lib/bot-create.ts`、`lib/bot-update.ts`、H 的 `slots/new-bot.tsx`、`bot-overview.tsx`、`app-frame.tsx`。

**本会话（协调）**
- 写决策文件（`docs/design/decisions/` 当日各一份）：Environment 取代 Project、Bot = Captain 且不互转、新建只登记、工作区自定义状态、为付费实现新增 slot。
- 开 docs PR。
- 收各会话结果，核对 diff 和 PR。
- 最后整体验证。

依赖：
- S4 的 Save view 依赖 S3 的 `saved_views`：S3 先合并，或 S4 先不做 Save view。
- S5 的 machineSize 和 S6 都会碰 `workspace_environments`：S5 只加 `default_machine_size` 列，S6 只读 Environment。
- 共享文件 `messages/*.json`、`lib/db/schema.ts` 会冲突，按合并顺序 rebase。

**S7 共享内容与互通（只做后端 + API，不做前端）**
Alex 2026-11-19 的要求：Agent 和 Bot 都能读取其他 Agent / Bot 的内容，也能给对方发消息、靠消息唤醒对方。现状：main 已经有 Drive（`lib/drive/*`，版本化文件树，作用域 user / project / project-user / team-workspace，`app/api/drive/**`），但还没有接到任何 Agent 或 Bot；mailbox 只能在同一用户之间发；`sendThreadMessage` 能续上已结束的线程，但没有作为工具开放。
- **Drive 接入**：
  - DRIVE_SCOPES 加 bot / thread / environment / workspace 作用域（`lib/drive/contract.ts`）。
  - Bot（EVE，`workflows/coordinator/tools.ts`）和 Agent worker MCP（`app/api/mcp/route.ts`）都加 `drive_list / drive_read / drive_write`。
  - 运行开始时把可访问的 Drive 同步到 E2B / 设备的 `~/.mikka/drive/`，结束时把改动写回，参照 `lib/computer/bot-workspace.ts`。
- **读取工具**（Bot 和 Agent 都给）：
  - `read_thread_messages`
  - `read_run_diff`，复用 `/api/runs/[runId]/workspace/*`
  - `list_artifacts / read_artifact`，`lib/artifacts/*` 补读接口
  - `read_bot_chat(botId)`
  - 给 Agent 开放 `list_runs / get_run`
- **发消息并唤醒**：
  - `send_to_thread` 包装 `lib/thread-continue.ts` 的 `sendThreadMessage`，支持 queue / steer，能唤醒已经结束的线程。
  - `send_to_bot` 写入 `coordinator_events` 触发一轮。
  - mailbox 发给已结束的 run 时自动续上，不再投递失败。
- **跨用户 / 跨 Bot 权限**：
  - `resource_access_policies` 的被授权方加 bot / run 两种（`lib/resource-access/contract.ts`），授权检查走 canReadContent / canSteer。
  - mailbox 去掉「只能同一用户」的硬限制，改为工作区成员加 ACL。
  - 工具执行仍用 owner 身份，但读写对象要过 ACL。
- **外部 API**：
  - 补 `/api/v1` 的 threads / messages / artifacts / drive / bots 路由和 PAT scope。
  - `mksvc_` 服务 key 可以调用这些路由（`lib/api-auth.ts`、`lib/tokens/format.ts`）。
- 和其他包的边界：S6 只负责 Bot 字段，S7 只负责工具、权限和 API。两者都碰 `lib/db/schema.ts`，按合并顺序 rebase。

## Drive 的定位（回答 Alex 的问题，已按要求纳入 S7）
- **Capy 的 Drive 是什么**：一个按作用域划分的持久文件夹，不属于某个 agent。作用域有组织、项目、个人、自动化、Captain（源码 scope = {projectId, userId, automationId, captainJamId}）。每台运行机器启动时把可访问的 Drive 挂到 `~/.capy/drive/...`，结束后同步回去。这样每个 thread 虽然在各自的 VM 里跑，也能读写同一份规则（AGENTS.md / CREW.md）、技能、跨次运行的状态。
- **Mikka 现在的情况**：
  - Artifacts 是运行的产出物，供人看。
  - Memory 是个人记忆。
  - 两者都不是「挂进沙箱、运行之间共享」的文件夹。
- **结论**：Drive 不属于某个 Agent，而是按作用域共享的文件夹。每个 Agent / Bot 运行时，把它有权限访问的那些作用域挂进来。所以「每个 Agent 有自己的文件」用 bot / thread 作用域实现，「大家共用」用 environment / workspace 作用域实现。这一轮只做后端、工具和 API（S7），不做 Drive 的前端页面。
- 之前写的「Drive 本轮不做」作废；本文前面「本轮新确认」里那句也以此为准。

## 验证
- 每个会话：
  - 跑 `pnpm check`、typecheck、lint、所改部分的单元和数据库测试、`pnpm test:local-loop`。
  - UI 用本地生产构建截图，和 Figma 对应节对照后附在 PR 上。
  - 迁移在隔离的 PG17 上跑通并验证回填。
- 遵守 AGENTS.md：不新增轮询，错误带 cause，中英文案都齐，线程术语用 thread / 线程，功能默认开启。
- 涉及模型的实时验收，走两条订阅路径（`claude-haiku-5-5`、`gpt-6-luna`）。
- Slack 身份发帖、按 PR 合并，在生产用共享测试账号做真实验收。
- 收尾：本会话汇总各 PR，开一轮最终 review subagent，再向 Alex 报告。
