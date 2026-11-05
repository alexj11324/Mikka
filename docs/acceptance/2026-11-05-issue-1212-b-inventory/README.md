# #1212 B：主线 producer / consumer 清单与下一件独立工作

时间：2026-11-05 01:25 UTC。固定源码：`efef5b5a5a8a55deb3c504b05fb736d4003e942c`，tree `26ceed5c34a4409bae48dc6bc39c0f23a8529a9a`。本次亲取正文列出的全部 20 个 consumer 和下列相关服务源码；`source-manifest.json` 记录路径与 Git blob。此前草稿和生产验收不计入主线完成数。

结论：20 个入口中，9 个已在主线接入对应 live 读取，11 个仍有正文所指的业务轮询。这个计数是源码接线状态，不是 9 个入口的生产或性能验收通过。下一件建议并已获主任务授权的是 **DesktopIntegration 的任务徽标和系统通知读取**；复用现有 task-run 通道，不新增推送协议。

## 20 个 consumer 的当前状态

路径均相对仓库根目录。引用固定版本：[main source](https://github.com/alexj11324/Mikka/tree/efef5b5a5a8a55deb3c504b05fb736d4003e942c)。

| Consumer | 当前读取 / 触发 | 代码状态 |
|---|---|---|
| `components/workspace/task-detail.tsx:108` | `DocumentSync.exchange` / `exchangeDocument` 每 1.5 秒；还承担本地 Yjs 改动上传 | 未迁移；不能只删除 timer 而丢失写入驱动 |
| `components/workspace/issue-thread-panel.tsx:83–94` | `getIssueThread` 活动时 2 秒；终态问题或模型切换等待从 2 秒退避至 30 秒 | 未迁移；保留当前 question-wake 语义 |
| `hooks/use-computer.ts:16–21` | `computer_state`，interval 0，canonical workspace 与 deadline | 主状态已迁移；`:38–40` viewer grant 到期前 30 秒续签另列，不是可直接删的状态轮询 |
| `components/workspace/group-chat-view.tsx:58–70` | 正常 group API、after 增量；回答时 2.5 秒，闲时 0 | 未迁移；group_list 只是侧栏列表，不等于群消息通知 |
| `components/coordinator/coordinator-chat.tsx:154–166` | `pollCoordinatorChat`；闲时 30 秒、运行 3 秒、流中 15 秒 | 未迁移；不可用 bot_chat_list 的摘要变化冒充完整会话 producer 闭合 |
| `components/workspace/factory-acceptance-pane.tsx:68–70,130–131,200` | `factory_task`，ledger/detail/approval interval 0 | 已接入 Factory live |
| `components/devices/devices-settings.tsx:255` | `listDevices` 每 5 秒；含 gateway presence / lastSeen 派生在线状态 | 未迁移；在线自然到期与 durable metadata 分开 |
| `components/workspace/issue-threads.tsx:15–16` | `listIssueThreads`，任一活动线程时 5 秒，否则 0 | 未迁移；不是已迁移的全局 thread_list |
| `components/coordinator/pending-actions.tsx:49–50` | `pending_actions`，interval 0，原审批 TTL deadline | 已接入 |
| `components/coordinator/approved-write-actions.tsx:28–31,77–87` | `approved_writes` / `approved_write`，列表和结果 interval 0、deadline | 已接入 |
| `components/workspace/issue-members.tsx:28` | `listMembers` 每 10 秒 | 未迁移 |
| `components/workspace/issue-relations.tsx:47` | `listIssueConnections` 每 10 秒 | 未迁移 |
| `components/workspace/factory-acceptance.tsx:27–28` | `factory_issue`，interval 0 | 已接入 |
| `components/artifacts/artifact-viewer.tsx:58` | `getArtifact` 每 15 秒；具体版本正文按版本 key 读取 | 未迁移；读取集合还包含 share 状态、Agent/Bot 作者外观 |
| `components/desktop/desktop-integration.tsx:17,34–38` | 桌面独有 `listTaskRuns` 每 15 秒 | **本轮选定下一件** |
| `components/workspace/board-page.tsx:153` | `useLiveTaskRunList` | 目标 task-run 读取已迁移 |
| `components/workspace/issue-workspace.tsx:124,130,170,191,194` | workspace_settings / issue、thread、bot、group live lists | 目标列表已迁移 |
| `components/nav/bot-list.tsx:124,127` | `useLiveBotChatList` / `useLiveGroupList` | 目标摘要与群列表已迁移；双击 UI timer 不是数据库轮询 |
| `components/settings/settings-data-preloader.tsx:27–36` | workspace_settings；成员、目录、team keys 采用 interval 0 | 目标预取列表已迁移 |
| `components/workspace/issue-pull-request-link.tsx:43–45` | expanded 每 60 秒，compact 仅初始读；POST `/api/github/pull-request-status` | 未迁移；这是当前 viewer 的 GitHub 授权读取，不是共享 issue metadata 的状态 |

## 尚未迁移类别：已核实际 producer 与注意事项

以下是下一批实现的入口清单，不冒称对每个未选类别已完成全部 writer 闭合或实际负例。正文要求仍按类别独立推进。

| 读取集合 | 已亲读的实际写入入口 / 依赖 | 尚需证明的边界 |
|---|---|---|
| 文档协作 | `app/actions/collaboration.ts::exchangeDocument` 在同事务更新 issue_documents / issues；`lib/document-sync.ts` 保存本地版本、acknowledged、known、flush；issue 保存和 Linear 文档写入还需同类接入 | 本地 dirty 仍触发上传；远端通知只拉增量；外层 rollback、同时编辑、scope 撤销、隐藏/恢复；原 #1236 草稿未落主线 |
| 单个 issue 线程列表 / 对话 | `app/actions/agents.ts::{listIssueThreads,getIssueThread,getThreadChanges}` 读 run 链、消息、chunks、diff、Factory question；`lib/agent-runs.ts::addRunMessage`、`lib/run-control.ts`、`app/v1/runs/[runId]/{route,events/route}`、Factory questions/continuation 是实际变更入口 | 增量 chunks 与状态不可只靠 task_run_list；原 SID、question-wake、模型切换、终态通知、跨 Owner / issue 权限；不覆盖 #1287 新接线 |
| 群消息 / 回答状态 | `lib/group-conversations-store.ts::handleGroup` 写消息、成员、read receipt；`lib/coordinator/group-turns.ts::{enqueueGroupTurn,processGroupTurn,stopGroupTurns}` 写 queued/running/complete/failed，正常公聊 publish 写 conversation_messages，私聊 publish 走 appendGroupExchange | 完整消息与 group_turn 状态都要 post-COMMIT；旧页 after/cursor、移除成员、私聊隔离；#1300 的停止竞态修复仍独立，不能据此删 1 秒 stop 检查 |
| Coordinator 会话 | `lib/coordinator/store.ts::{takeInbox,releaseLease,appendMessages,retryFailedTurn,failTurn,setEventTier,completeTriageAttempt}`；`recordCoordinatorEvent` 为独立事件来源，已有 bot_chat_list 摘要通知 | 完整 messages、working、stream 状态与事件元数据；#1255 属 egress 维护，当前未合主线；不得重复实现 |
| 设备列表 | `app/actions/agents.ts::{setDeviceEnabled,renameDevice,removeDevice,sendDeviceCommand}` → device-removal / device-management；`listDevices` 还读 device_repos、harnesses 与 `deviceOnlineStates` | 配对/注册、heartbeat/capability/repo 变化仍需全部映射；无写自然离线不可依赖普通 commit 通知；保留既有撤权与 stop 时限 |
| Issue 成员 | `app/actions/collaboration.ts::{inviteMember,removeMember}`；invite 是实际 INSERT，remove 在事务内且可能清 assignee / issue version | invite 当前无对应 detail 通知；remove 的 issue_list 通知只在清 assignee 分支。移除者清缓存、其他成员、外层回滚、同 Owner 跨 workspace 需单独覆盖 |
| Issue 关系 | `app/actions/issue-operations.ts::{updateIssueRelation,createLinkedIssue,setIssueDeleted}`；`app/actions/issues.ts::moveIssue`；关系读读取相关 issue 元数据及可见性 | 双向端点、父子/duplicate、移动/删除、成员权限变化影响关系读集合；既有 issue_list 不能直接当每个 detail 的事件 |
| Artifact detail | `lib/artifacts/store.ts::{submitArtifact,createShare,revokeShares}`；`lib/artifacts/delete.ts::deleteOwnArtifact`；`detail/readArtifact` 还派生 Agent 名称 / harness、Bot 名称/颜色/形状及 share existence | 固定版本与 latest、删除、share revoke、派生外观；reader 现在是 owner 私有，不应猜当前选中 workspace 或将 share token 发到 live |
| GitHub PR status | `app/api/github/pull-request-status/route.ts` 每次重新核 session、Origin、issue link、viewer 的 GitHub 授权，再读外部 GitHub；明确不把该状态写入共享 metadata。`lib/github/publication-webhook.ts` 仅是既有 publication/issue 数据的一路 writer | Webhook 覆盖范围不能替代任意 viewer 的授权或私有 repo access；未获覆盖证明前不能用已有 Factory webhook 状态伪装新鲜远端结果 |

## 下一件：DesktopIntegration 消费现有 task-run 通道

### 已有的完整接线基础

1. `components/workspace-app.tsx:41–46` 已将 DesktopIntegration、SettingsDataPreloader 与 Workspace 页面放在同一个 LiveProvider，Owner 来源是正常页面 session。无需再建 socket manager、CF 资源或嵌套私有 provider。
2. `app/actions/task-runs.ts:38–63`：`listTaskRuns()` 本来就是 `pollTaskRuns().items`。后者查相同 Owner、最近 30 天、每 issue 最新 run，并返回 server-observed owner、canonical personal home 与窗口到期时间。迁移不换读授权或业务数据集合。
3. `hooks/use-live-lists.ts:66–75` 已有 `useLiveTaskRunList`：owner-bound SWR key、owner 回读校验、home 作用域、2 秒合并、30 天 deadline、统一 hidden/重连/慢速补读。
4. `lib/live/lists.ts:36–41,114–127` 已将真实 run 状态的提交后失效映射到持久化 run.userId 的 personal home。body 中没有 run 内容。reply-preview-only 不刷新 task_run_list；普通 heartbeat 不应新增这种事件。

### 沿用的 producer，当前不需要修改

实际状态来源包括 `run-dispatch.ts` / `run-admission-store.ts`、`computer/queue-run.ts`、`computer/claim.ts`、`factory/execution-claim.ts` / `checks.ts` / `questions/store.ts` / `questions/retry.ts`、`run-control.ts`、`run-completion.ts`、`run-publications.ts`、`run-leases.ts`、`run-provider-fallback.ts`、`run-quota.ts`、`agent-tool-approval/store.ts`、`device-revocation.ts`、`model-api-key-runs.ts`、`personal-policy.ts`、`cloud-computer/thread-machines.ts`、`app/v1/runs/[runId]/route.ts` 和 `events/route.ts` 的已有 `runListChanged`。这些是 #1291 已接入的生产路径，下一件不重写状态机。

标题/外观变化通过已有 `issueListChanged(..., titleChanged=true)`、`botListChanged`、`ownerProfileListsChanged` 等到达 task_run_list；30 天自然过期通过读取给出的 deadline，不能省掉。这里只复用既有合同，不据 producer 名单宣称生产观测完成。

### 最小改动边界

- 仅桌面运行时挂载任务消费子组件，调用现有 `useLiveTaskRunList` 并消费 `.items`；普通 Web 不订阅、不请求 task-run 数据。优先用组件挂载边界，避免扩公共 hook 参数。
- 保留 preferences 的 finished 开关、初始快照只建 baseline 不重放旧通知、badge 和 `desktopRunUpdate` 的转换规则。
- Owner 变化使 baseline 重新建立；卸载、切 Owner 后，旧 Decision Promise 返回也不得对新 Owner 弹通知。所有 callback guard 应覆盖实际 Promise 完成时刻。
- `chooseDesktopNotifications` 原有正常 session + 当前 listTaskRuns 授权核对保持；不换 Decision 模型、不绕过该检查、不从通知数据直接执行外部动作。
- 保留点击、deep link 和本机 daemon 安装效果的现有行为。

### 必要负例与证据

- 真实 React/SWR/LiveChannels 组合：Web 模式零 task read/零 subscription；desktop 初读与另一个 task-run consumer 去重；健康静默期没有 15 秒查询。
- 提交后 state invalidation 才刷新，错误 Owner/workspace channel 不刷新；payload 仍走普通授权 reader。原 main writer 的事务/回滚门禁不重复发明另一层 mock。
- Owner A 的读取 / Decision Promise 延迟到 Owner B 后返回：B baseline 不混入 A，A 不弹通知；卸载同样无 late show。首次读取已有 waiting/failed 状态不重放旧通知。
- finished 开关关闭无完成通知，开启才按原规则选择；Decision 拒绝、错误、当前状态已不同仍按原服务端行为处理；测试只替换外部 Decision 边界，不调用收费服务。
- hidden 不轮询、重连/前台补读、60 秒 fallback 与 30 天 deadline 沿用共享通道；实际 UI 集成要覆盖本组件接线，不能只测纯 options 对象。
- 本项无新的可见 UI 文案/布局，是否需要新截图按最终实际 diff 判断；相同呈现 blob 与真实构建证据不能冒称生产验收。

## 跟踪与限制

- 2026-11-05 只读与 fresh 对齐：#1236 最后维护公开 head `3f426…`，两面板未落 main，后续由 root 整合；#1255 在 egress 维护且未合 main；desktop 文件无其他 agent 预占。
- 本清单没有执行任何模型、没有改变账号/生产状态。下一件代码必须先交 root 独审，再 draft PR；不自行合并。
- #1212 正文每 PR 前后一小时及生产发布/验收要求仍然有效。新建小类或关联其他 issue 都不是绕过门禁的理由。

Refs #1212, #1211.
