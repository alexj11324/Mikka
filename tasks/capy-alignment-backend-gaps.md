# 对齐 Capy：后端缺口清单（2026-11-19）

依据 `origin/main` 只读审计。A = 界面已有；B = 后端已支持、界面没露出；C = 后端缺失。
Figma 对照页：`待 Alex 审核 · 交互、弹窗与 Automations 对齐 Capy（2026-11-19）`（1235:2）。

## Automations（22 项）

| # | Capy 功能 | 状态 | 需要的后端工作 |
|---|---|---|---|
| 1 | 页签 My / All / Scheduled | B | `scheduleListInput` 加 `owner: 'me'`、`trigger: 'schedule'`（列表按 100 条分页，前端筛不全） |
| 2 | 「Creator is Me」筛选 + 筛选/显示菜单 | B | 同 #1 |
| 3 | 「Active N」分组 | B | 可选：list 加按状态计数 |
| 4 | 行：触发器图标、创建者头像、时区计划文本 | A/B | `withCreators` join `"user".image` 返回 `owner_image` |
| 5 | 页内 Templates 卡片网格 | B | 纯前端；Sentry 卡片先占位 |
| 6 | 创建对话框（从零 / 模板 / 让 Bot 建） | A | `tools.ts:8` 工具描述补上 `dispatch_task` |
| 7 | 描述 | C | `definitionSchema` 加 `description`（jsonb，无迁移） |
| 8 | Runs in：A new thread each run / One standing thread / An existing thread（可搜索，Captain 在此选） | 大部分 A | 新线程、固定线程 = `eachRun`；交给 Bot = 现有 Hand to（Bot 对应 Captain，并入 Runs in，不单列）；指定任意已有对话需 `definition.singleConversationId`（无迁移） |
| 9 | Project 多选 | C | `dispatch_task.projectIds`；validate 检查访问权；派发后写 `workspace_project_tasks` |
| 10 | Runs as 指定的人 | C | **迁移**：`user_schedules.run_as_user_id`；授权规则；dispatch/validate/计费改用它 |
| 11 | Post as run-as 的人 | C | Slack `chat:write.customize` 或 user token；`notify.slack.postAsRunner` |
| 12 | Quiet Slack posts | C（小） | `notify.slack.quiet`；只有做富卡片后才有意义 |
| 13 | 触发器列表 + Add trigger 菜单 | 多数 A，部分 B/C | 多条定时：`timing` → `timings[]`（C）；GitHub 拆 PR/Issue comment（B）；加 `pull_request_review_thread`/`push`/`workflow_run`（C，需改 App manifest）；Sentry 全新集成（C） |
| 14 | 模型 + 推理强度 | C | `dispatch_task.model`、`effort`；透传到 `recordPersonalSubmission` |
| 15 | Limits：每日上限 / 机器规格 | 上限 A，规格 C | `definition.machineSize`；`MACHINE_SIZES` 加 4 vCPU/16 GiB；**迁移** `workspace_projects.default_machine_size`；替换 `sponsored-lifecycle` 写死的默认值 |
| 16 | Organize 作用到每次运行的线程 | C | `definition.runs.{pin,folder,tags}`；线程级文件夹/标签表（新建） |
| 17 | Usage 图表 30 天 | B | 前端传 `days: 30` |
| 18 | Drive | C | 新表 `schedule_drive_files` + R2；上传/列出/删除；运行时挂载与回写 |
| 19 | 详情 Active 开关 + By | A | 头像同 #4 |
| 20 | ⋯：Run now / Duplicate to › / Delete | Run/Delete A；复制 B/C | 跨工作区/项目：新 `duplicate` 命令，目标端重新校验 |
| 21 | View runs → 线程列表按自动化筛选 + Save view | C | **迁移**：issues 或 agent_runs 加 `source_schedule_id`，派发写入并回填；列表支持 `automation=<id>`；服务端视图表 |
| 22 | 显式 Save | A | — |

## 工作包

1. **定义字段扩展（无迁移）**：description、projectIds、model/effort、machineSize、notify.slack.quiet/postAsRunner、runs.{pin,folder,tags}、timings[]；改工具描述。
2. **运行身份（迁移）**：run_as_user_id + 授权 + 计费；Slack 以其身份发帖。
3. **派发落地**：项目关联、模型强度、机器规格、新线程置顶/文件夹/标签；失败按 `disabled_reason` 自动暂停。
4. **触发器**：GitHub 三个新事件 + comment 拆分；Sentry 集成；多条定时。
5. **列表查询**：owner/trigger 筛选、状态计数、创建者头像。
6. **自动化 ↔ 线程关联（迁移）**：source_schedule_id、automation 筛选、服务端保存视图。
7. **复制**：duplicate 命令。
8. **Drive**：新表 + 对象存储 + 运行时挂载。

## 新建任务：Capy 的真实逻辑（Capy 0.9.2 renderer `features/issues/new-issue-dialog.tsx`）

- issue 是纯记录：`issues.create` 只写入，不开 thread。开工另算：指派给 Captain 后 Captain 收到 `issue_activity` 再决定派 thread（服务端是否自动唤醒未证实），或详情页 Link thread。一个 issue 可挂多个 thread（owner thread）和 PR。
- 字段：Project 面包屑、标题（必填，Enter 提交）、描述（@ 提及）、Status（组织默认 open 状态）、Priority（默认 normal；urgent/high/normal/low，无 No priority）、Assignee（People + Captains，单选）、Due date、Labels（可新建）、Access（org / private）、附件、语音、Create more。
- 状态由组织自定义（open/closed + 默认）；Needs you / Waiting 是该组织自建状态，thread 运行态另算。
- 指派给 Captain = 唤醒（已由 Electron renderer 确认）：`assignee_changed` 事件以 `issue_activity` 通知写进 Captain 对话（"X assigned you CAP-xx"），属于 wake rows，样例状态 `answered`；评论、@ 提及、状态变更同理；agent 也会反向改 issue（"moved it to In review"）。Mikka 对应：任务 assignee_changed 时往该 Bot 对话投通知并触发一轮（WP7）。
- Mikka main 的新建弹窗混了 Create only 与 Create and dispatch（选 Bot / Machine / Agent / Profile），这是不一一对应的根源。拟改：新建只登记，派发移到详情页「Start work」，指派给 Bot 即开工信号。

## 任务 / PR（依据 `origin/main` 08e204792、`.hosted-ui` b7739b1）

总体：任务的 labels / dueDate / assignee / relations / PR / subscribers 都存在 `issues.content.attrs.mikka` JSON（`lib/issue-metadata.ts:19-37`）；服务端列表只认 `dispatchedBy / projectId / teamId / parentId`（`lib/task-list-page.ts:5`），其余筛选只作用于已加载的 100 条。

| 功能 | 状态 | 需要的后端 |
|---|---|---|
| 页签 All / Created by me / Needs you | A | — |
| 页签 Assigned to me | B | `taskListPageInput.assignee` |
| 页签 For you / Mentioned | C | 提及表 + For you 的产品定义 |
| 筛选 Status / Priority / Labels / Project / Assignee | A | — |
| 筛选 Bots I'm in、Creator（只有 Me）、Due date、Subscribers、Relations、PR、Hide closed sub-tasks、Match any/all | B | 服务端过滤参数 + jsonb 索引 |
| 筛选 Mentions | C | 见 WP3 |
| 显示 Ordering / Properties | A | — |
| 显示 Grouping / Direction / Sub-tasks | B | 纯前端；跨设备需偏好表 |
| 行菜单 Status / Priority / Assignee / Labels | A | — |
| 行菜单 Open in new tab / Copy link / Copy ID / Subscribe | B | 详情 ⋯ 已有，行菜单补上 |
| 行菜单 Mark as unread | C | 见 WP2 |
| 状态 Backlog…Duplicate | A | — |
| 状态 Needs you / Waiting / Blocked | 派生（`lib/task-state.ts:48-75`） | 要可手选：迁移 status CHECK 或自定义状态表 |
| No priority | C | 迁移 priority CHECK / 可空 |
| Due date / Labels / Relations / Sub-tasks / 任务↔PR | A | — |
| 订阅后收到通知 | C | 见 WP1 |
| 新建：Create more / 附件 | A | — |
| 新建：指派人、Due date、Labels | B | 加入 `createOnlyCommand` |
| 新建：可见性 | B | `createOnlyCommand.visibility` + `setTaskVisibility` |
| 新建：语音 | B | 任务听写接口（复用 `transcribeChatAudio`） |
| PR 页签 / 分组 / State / Repository / Author / Conversation | A | — |
| PR 筛选 Bot | B | `directoryInput.botId` 已有 |
| PR 筛选 Created / Since | B/C | 接口加 `since` |
| PR 筛选 Project | C | 经关联任务 join 项目 |
| PR Pin | A（仅 sessionStorage） | 跨设备见 WP4 |
| PR Open in GitHub / Copy link | A | — |
| PR Copy branch | B | 关联模式补 head |
| PR Open in new tab | C | PR 详情路由 + 读取接口 |
| PR 详情 diff / merge | 仅关联任务的 PR | 按 PR 合并的 API（复用 `githubMergeApi`） |

### 工作包

- **WP1 订阅与通知（迁移）**：`task_subscriptions` 表，任务活动推送收件箱。
- **WP2 任务已读未读（迁移）**：`task_reads` 表，`markTaskRead / markTaskUnread`，行返回 `unread`。
- **WP3 提及（迁移）**：`task_mentions` 表，保存时解析 mention 节点，Mentioned 页签与通知。
- **WP4 PR 置顶与保存视图（迁移）**：`pull_pins`、`saved_views`。
- **WP5 列表服务端过滤（索引迁移）**：`taskListPageInput` 加 assignee / creator / label / due / hasPr / relation / subscribed / hideClosedChildren / match。
- **WP6 No priority 与可选状态（迁移）**：放宽 priority / status CHECK，或自定义状态表 `workspace_issue_states`。
- **WP7 新建任务（无迁移）**：`createOnlyCommand` 加 assignee / dueDate / labels / visibility；任务听写；指派给 Bot 写入「被指派」事件。
- **WP8 PR 目录（无迁移）**：since / projectId 参数、关联模式补字段、PR 详情路由、按 PR 合并。
- **WP9 For you**：先定义产品规则，再由 WP1 / WP3 / WP5 组合。

## Bot ↔ Captain 设置对齐（Capy 0.9.2 `features/captain/dialogs.tsx`、docs.capy.ai/captains；Mikka `origin/main`）

原则：Capy 的环境、仓库、密钥、机器规格都挂在**项目**上，Captain 只管「身份 + 项目 + 模型 + 在哪跑 + 谁能用」，规则靠 Captain Drive 里的文件（AGENTS.md / CREW.md）自然语言维护。Mikka 的 Bot 照这个分层，不给 Bot 单做环境配置页。

| 设置 | Capy 层级 | Mikka 现状 | 需要的工作 |
|---|---|---|---|
| 名称 / 头像 | Captain | Bot 已有 | — |
| 描述（≤140） | Captain | 有「公开角色」≤2000 | 复用，改文案 |
| Alias（Slack `captain=`） | Captain | 无 | `bots.alias` + Slack 路由（迁移） |
| 项目（创建后不可改） | Captain | Bot 只有 repository，无 project | `bots.project_id`（迁移） |
| 模型 | Captain，crew 继承 | Bot 已有（bot_model_choices） | — |
| 推理强度 | Captain | 无 | 模型选择加 effort（无迁移，jsonb/列视实现） |
| Bot 自己在哪跑 | Captain（Cloud / 设备 + worktree/linked） | 每人每工作区一台云机，Bot 占 display | Bot 级 machine 目标（迁移） |
| Crew runs on（派出的任务默认跑哪） | Captain（Cloud / 某台设备） | 任务级临时选；个人×工作区默认位置 | `bots.crew_target`（迁移），派发时作为默认 |
| 默认 Agent / Profile | — | 任务级选 | Mikka 独有：可作为 Bot 默认值（与 crew target 同列） |
| 可见性 / 成员 / 订阅 / 转移所有者 | Captain | 无（Bot 只有 owner） | 成员 / 订阅表 + 转移（迁移） |
| 规则 / 计划 / 技能 | Captain Drive 文件 | 只有个人级 personalInstructions | Bot Drive（AGENTS.md / CREW.md），依赖 Automations WP8 的存储 |
| Promote thread → Captain / Demote | Captain | 无 | **不做**：Bot 跑 EVE，对话跑 Claude Code / Codex，运行时不同不能互转 |
| 归档 / 删除 | Captain | Bot 已有 | — |
| 仓库 / Dev environment / 脚本 / snapshot | 项目 | 工作区 environments + 项目默认环境 已有 | snapshot 缺 |
| 机器规格 | 项目（默认 large 4c/16G） | 组织级 | 同 Automations #15：`workspace_projects.default_machine_size` |
| 环境变量 / secrets | 项目共享 / 个人 / thread | 工作区·仓库 / 个人 | 缺 thread 级覆盖 |
| 设备权限（含 computer use 开关） | 设备 | 设备 enabled / maxConcurrentRuns | 加 共享给组织 / computerUse 开关 |

- 决定（2026-11-19）：Bot 右键菜单保留 Mikka 独有的 Copy link / Mute / View all threads / Hide，与 Capy 的 10 项并存。
- 决定（2026-11-19）：不做 Bot ↔ 对话的 Promote / Demote。Bot 用 Mikka 自有 harness EVE，对话和任务用 Claude Code / Codex，换运行时不合适。

## 命名与分层决定：Environment 取代 Project（2026-11-19）

- Mikka 用 **Environment** 管仓库、setup script、环境变量、secrets，参考 Claude Code 的 cloud environment（Name / Network access / Network secrets / Setup script / Environment variables）。**暂不做 Network access 限制。**
- Capy 的「项目（仓库清单、dev environment、变量）」在 Mikka 对应 Environment。现有 `workspace_environments`（repositoryKeys / setup / variables / secretIds，lib/project-resources/contracts.ts:15-24）基本就是它；默认环境不可改名、不可归档。
- **Bot**：绑定一个 Environment → `bots.environment_id`（迁移，可改）；`bots.repository` 下线，数据迁进对应 Environment 的仓库列表。
- **自动化**：每次运行用一个 Environment → `definition.environmentId`（单选，jsonb 无迁移），替代上文 #9 的 `projectIds`。
- **任务 / 对话**：启动时从 Environment 取仓库，记录实际检出的仓库与分支（对应 Capy 输入框下的「N repos」运行状态）。
- **机器规格默认值**：从「项目默认」改为「Environment 默认」→ `workspace_environments.default_machine_size`（迁移），替代上文 #15 的 `workspace_projects.default_machine_size`。
- 任务看板上的 Project（任务归属、筛选）不受影响，仍是组织任务用的项目。
