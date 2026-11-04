# 项目地图后端 RFC

- **Status:** in review；等待 Alex 在本 PR 评审通过。本文不是已获批准的实现规格。
- **GitHub:** 父 issue [#1243](https://github.com/alexj11324/Mikka/issues/1243)；本 RFC [#1244](https://github.com/alexj11324/Mikka/issues/1244)；实施依次为 [#1245](https://github.com/alexj11324/Mikka/issues/1245)、[#1246](https://github.com/alexj11324/Mikka/issues/1246)、[#1247](https://github.com/alexj11324/Mikka/issues/1247)。
- **Owner thread:** ChatGPT Pro，项目地图后端。
- **Review gate:** Alex 通过后才合并本文、开始 #1245～#1247；本 PR 仅新增此文档。
- **前端边界:** [#1248](https://github.com/alexj11324/Mikka/issues/1248) 由另一个 Claude Code session 负责；本文规定接口、权限和状态，不实现页面、组件、Figma 或视觉样式。
- **源码基线:** `main@a2598ecb3a4b1ef128eb49f60a934d5f75bc5b52`（2026-11-04）；实施时复核相关接口的新变更。
- **设计来源:** #1243「方案」「前端要的形状」和 [2026-11-04-1726 决定](https://github.com/alexj11324/Mikka/blob/feat/project-map/docs/design/decisions/2026-11-04-1726-project-map.md)。`feat/project-map` 的代码仅为未评审 WIP，不作为数据模型依据。

## 1. 用户要完成什么

用户打开项目的「地图」，能看清项目走过的路线、为什么换方向、哪些路线停止，以及每一步对应的 Artifact、代码提交、PR、检查和原始对话。编码可能来自 Mikka 派出的 Agent，也可能来自用户自己终端中的 Claude Code / Codex；没有 Mikka run 的编码记录仍须能进入地图。

本方案沿用已定分工：Entire 保存编码过程，Mikka 保存任务流程和当场决定，后端把这些原始事实投影为地图。地图不成为另一套任务状态机，也不把每次工具调用都画成节点。

### 1.1 建议本次评审确认的设计

1. **事实持久化，图即时推导。** 新增决定事实、来源引用、仓库记录配置及可重建的 Entire 索引；不新增持久化的 `map_nodes`、`map_edges`、lane 或分支状态表。
2. **决定和记录者分开。** 「谁拍板」与「哪个 bot / Agent 记录」是两个字段；客户端不能自行声称自己代表 Owner 或另一位用户。
3. **依据不足就留空。** 重试、失败、候选更新、issue 父子关系均不自动等于方案分叉或放弃；推断必须另标 `inferred`，不能覆盖当场记录。
4. **权限逐项检查。** 项目可见不等于私有线程、聊天、凭证归属和完整 Entire 对话可见。新接口不扩大现有共享权限。
5. **收集和读取分离。** 地图 GET 只读数据库中的安全投影；不调用模型、不拉 Git 仓库、不在浏览器请求里跑 Entire。
6. **同一版本内布局稳定。** 先对完整的可见事实做拓扑和 lane 分配，再筛选、折叠和分页；事实改变使游标明确失效，不混合两个版本。
7. **沿用官方 E2B 模板。** Entire 随 Mikka worker 发布并在机器启动时安装，不修改官方模板；用户本机和自管服务器按明确的仓库授权安装 hooks。

这里的「分支」是项目方案的路线，`gitBranch` 是 Git 分支名，`lane` 是一次布局中的显示列；三者不得混为同一个持久化字段。

## 2. 现有事实与接入位置

以下均为源码基线的现状；表名以现有代码为准，不在本项目中顺带重命名。

| 事实 | 现有来源 | 地图使用方式 |
| --- | --- | --- |
| 项目及任务列表 | `lib/db/project-schema.ts` 的 `workspace_projects`：`userId`、`issueIds`、`revision`；`app/actions/projects.ts` | 用项目 ID 和 task ID 关联，不能用可改名的项目名称作为外键；现有每项目 100 个 task 的限制不妨碍产生几百个地图节点 |
| 项目工作区和可见性 | `lib/project-access.ts`；`mikka_team_projects`、`mikka_workspace_members` | 共享项目从 team-project link 得到 workspace；无 team link 的项目属于 owner 的个人工作区；`properties.members` 不是权限授权 |
| 任务关系 | `issues`、`issue_attrs` / `readIssueMetadata`、`lib/issue-access.ts`、`lib/issue-visibility.ts` | 项目成员、parent、blockedBy、related、duplicate 分别保留其语义；dependency 边不冒充路线分叉 |
| 线程与执行 | `agent_runs`；`lib/run-chain.ts`；`retryOf`、`continuesRunId`、`threadReplacedBy`、`agentDefinition` | 每个 run 是一个执行事实；线程 root 按现有规则解析；冻结的执行身份优先于 bot 的当前设置 |
| 过程与插话 | `run_chunks(runId, seq)`、`run_messages`、bot/group chat 原始消息 | 详情按来源权限读取；地图列表不携带完整 chunk 或提示词 |
| Factory 工作 | `factory_tasks`、`factory_attempts(taskId, position)`、`factory_candidates(taskId, id)`、`factory_events(taskId, eventId)` | 候选、执行阶段、检查和状态改变分别引用；review/verify 只关联到它实际检查的 candidate |
| Owner 验收 | `factory_deliverable_acceptances`、Factory 的已提交事件 | 只在有确实的验收事实时标记通过；不能用某个旧候选的验收证明新候选通过 |
| 问题和回答 | `lib/factory/questions/store.ts` 的 `factory_questions`（含 answerId/answerSource/answer/answeredAt）、`agent_runs.questionContinuation` | 回答与 questionId、originRunId、continuationRunId 显式关联；没有另造 answers 表；必要时成为决定证据 |
| Artifact 与代码发布 | `artifacts`、`artifact_versions`、`run_publications`、候选 SHA、任务 PR 元数据 | 指向精确版本和候选；PR URL 或最新 Artifact 不能替代当时的版本 |
| 已有恢复 checkpoint | `run_checkpoints`、`lib/secrets/checkpoint.ts` | 这是故障恢复用的 diff，**不等于 Entire checkpoint**，两套 ID、生命周期和用途分开 |
| MCP 调用 | `app/api/mcp/route.ts`、`lib/mcp/{auth,worker,tools,actions,artifacts}.ts` | OAuth 和 worker 分别注册工具，共用服务层；仅改 `tools.ts` 不会让所有入口获得新工具 |
| 更新通知 | `lib/live/{events,scope,notify,factory}.ts` | 复用事务提交后的无内容失效通知；不增加每个项目的定时数据库扫描 |

**两套数据库边界：** 项目/工作区关系位于 `workspaceDb`，run/Factory 等位于应用数据库。遵循 `issueVisibility` 的做法先在工作区库解析权限，再把允许的 ID 带入应用库查询；不能跨两个连接做 SQL JOIN，也不能假装跨库事务具有原子性。

### 2.1 WIP 不继承的假设

`feat/project-map` 的 spec/build/server 中把无关任务按时间串联、由最近更新选主线、只跟单一前驱、以及每个 issue 单独取最新 Factory 的做法均不作为本方案依据。只参考已经确定的竖向布局与详情顺序。新后端保留历史、多父合流和独立权限投影；来源故障不能被统一 catch 成空图。WIP 仍归原 session，本文不修改其前端或代码。

## 3. 数据模型

### 3.1 项目与 workspace 的绑定

新增记录必须保存经过服务端解析的 `workspaceId` 和 `projectId`，不能把浏览器的当前工作区 cookie 当作最终归属。

- 共享项目：所有 `mikka_team_projects` link 必须指向同一个 workspace；按现有 active membership 和 team/issue 权限核对。
- 个人项目：无 team link，且 `project.userId` 为请求者；绑定此 owner 的个人 workspace。
- 同一项目如存在跨 workspace 的脏 link，返回 `PROJECT_SCOPE_CONFLICT`，不猜归属，也不把这些数据拼进地图。
- 不给现有项目表重复新增 `workspaceId`。新事实写入后不因项目改名而失联；项目转移或关系变化后重新验权，不能把旧 workspace 的私有事实自动共享到新 workspace。
- `project.issueIds` 是任务归属事实；`issue.metadata.project` 名称只用于兼容显示。名字相同不能关联，未绑定的外部仓库也不能靠仓库名自动进入项目。

### 3.2 `project_decisions`：不可变的决定事实

放在应用数据库，通过独立 schema 模块被 `lib/db/schema.ts` 导出。字段命名采用仓库的 camelCase 风格。

| 字段 | 类型 / 约束 | 含义 |
| --- | --- | --- |
| `id` | UUID，PK | 永久决定 ID |
| `workspaceId, projectId` | UUID，必填，写入时检查 | 精确归属；跨库的项目/workspace 不建立伪外键 |
| `ownerId` | text，必填 | 此内容的 owner；取认证用户或冻结执行身份的 owner，不把项目 owner 当成任意调用者的代名词，不信任请求字段 |
| `issueId, factoryTaskId, runId` | UUID，可空 | 至少 project 有效；提供的任务、Factory、run 必须互相匹配且当前可写 |
| `kind` | `choose / redirect / abandon / merge / confirm` | 选择、改向、放弃、合流、确认一个重要决定 |
| `title` | varchar(200)，必填 | 决定是什么 |
| `summary` | varchar(500)，必填 | 一句话结果 |
| `reason` | text，1～4,000 字符 | 决定理由；历史未知理由不通过空字符串伪造当场决定 |
| `options` | JSONB，0～20 个，强 schema | 见下方 option 结构；存决定的内容，不存地图坐标 |
| `selectedOptionId` | string，可空 | choose/redirect 必须且仅能指向一个 option；merge/abandon/confirm 可空 |
| `contextOptionRef` | `{decisionId, optionId}`，可空 | 此决定发生于哪条已存在路线；嵌套分叉的明确依据 |
| `predecessorDecisionIds` | UUID[]，最多 20 | 有明确先后/合流证据的前置决定；同项目、同 workspace、无循环 |
| `provenance` | `recorded / inferred` | 明确记录（含人工标记）或事后推断；明确记录与事后推断分开，是否当场还看 captureMode |
| `captureMode` | `live / human_marked / reconstructed`，服务端填充 | 当场工具写入、事后人工明确标记、事后推断；人工补标不显示为“当场记录” |
| `decidedBy` | JSONB | `human / bot / agent / unknown`，经验证的主体 ID；声称人拍板必须引用那个人的原话/批准事件 |
| `recordedBy` | JSONB，服务端填充 | `userId, botId?, runId?, harness?, modelId?, clientId?, identityAssurance`；未知模型保持 null |
| `occurredAt, recordedAt` | timestamptz | 事件时间与服务端接收时间分开；默认前者取可信来源时间，否则服务端时间；记录 client 声明时间不用于冒充审计时间 |
| `supersedesId` | UUID，可空 | 修正或撤销旧记录时追加一条；禁止原地重写历史理由 |
| `recordStatus` | `active / retracted` | retracted 也是追加事实；被修正记录仍能在详情追溯 |
| `idempotencyKey, payloadHash` | text，必填 | 幂等键由服务端加上 run/bot/OAuth client 调用身份命名空间；同 scope、同调用者重投返回同一条；同 key 不同 payload 为 409 |

Option 结构：

```ts
type DecisionOption = {
  id: string;                     // 此决定内稳定；不使用数组下标
  title: string;                   // <= 200
  disposition: "selected" | "rejected" | "abandoned" | "retained";
  reason: string | null;           // rejected/abandoned 必填；其他可空
  derivedFrom: { decisionId: string; optionId: string } | null;
  stoppedAtSourceRef: string | null;
};
```

`rejected` 表示考虑后未走；`abandoned` 表示确实走过再停下。图上都可画为未继续的路线，但详情必须区分，未走过的方案停在决定点。多方案合流通过 predecessor 和 source evidence 表达，不用把两个 selected option 塞进一次 choose。

对修改旧决定：新记录引用 `supersedesId`，以原记录当前版本为前提提交；同一次并发修正只有一条成功，其余 409。修正时必须拥有旧记录的写权限，不能把别人的记录覆盖成自己的。审计保留原来源和原理由。

**索引和数据库约束：**

- PK `id`；唯一 `(workspaceId, projectId, ownerId, idempotencyKey)`。
- `(workspaceId, projectId, occurredAt, id)`；`(runId, recordedAt)`；`(factoryTaskId, recordedAt)`；`(issueId, occurredAt)`；非空 `supersedesId` 唯一索引。
- 本库的 run/issue/Factory 引用使用 FK，追加记录与引用原子写入；跨库归属由服务层验证且在每次读时复核。
- 数据库 CHECK 约束 kind/provenance/status/JSON 基本类型和长度；跨记录的 scope、option 引用、无循环、source ACL 由同一服务层事务验证，不靠模型守约。
- 本库可删除的 run/issue/Factory 外键采用 `ON DELETE SET NULL`，归属和 source 定位器保留审计事实并标 `unavailable`，不能阻止正常来源删除。decision→sources 随决定记录清理采用 CASCADE；项目/账号删除则清理归属的决定、引用与索引，跨库清理接入已有删除流程。sourceRef 自身不授予已删除来源的读取权。

### 3.3 `project_decision_sources`：结构化来源与路线归属

不要只存一段 URL。来源表包含：

`id, decisionId, ownerId, workspaceId, role, optionId?, sourceType, sourceId, sourceVersion?, sourceSubkey?, relation, verifiedAt, createdAt`。

- `role`：`evidence / branch_work / stopped_at / merges_from`。
- `relation`：`declared / host_verified / inferred`。模型说“有关联”不是主机已验证。
- `optionId` 对应本决定或明确的 `contextOptionRef`，用于确定哪次执行真正走在哪条路线。
- 唯一 `(decisionId, role, optionId, sourceType, sourceId, sourceVersion, sourceSubkey)` 使用 NULL-safe 的规范化 key；索引 `(workspaceId, sourceType, sourceId)` 供从 run/候选回查。
- 单次决定最多 50 个引用，批量校验，整条失败时不留下半条决定。
- 图只解释这些语义引用，不在这里保存 `parentNodeId`、lane 或显示顺序。

| `sourceType` | 定位器 | 读取与校验 |
| --- | --- | --- |
| `issue` | issue UUID + revision | `issueForUser/issueVisibility`，项目任务集合内 |
| `run` | run UUID | owner、issue、冻结执行身份和 workspace 一致 |
| `run_chunk` | run UUID + seq | 同上，按 `(runId,seq)` 取，不传整段 stream |
| `run_message` | message UUID + run UUID（可空） | 有 run 时必须匹配；无 run 的 mailbox 输入按其真实 owner/地址作用域读取，不能伪造为执行输出；保留真实作者 |
| `bot_message` | bot UUID + message position | 沿用 bot 私有 chat 的读取权限 |
| `group_message` | conversation UUID + message ID/position | 沿用群成员和消息范围检查 |
| `question / answer` | factory questionId + revision / answerId | 读取 factory_questions 的真实 answerSource/answerSourceEventId 与回答，核对 waitingBinding、origin run、continuation；agent 的补充 context 不算人类授权，不另存一份回答 |
| `factory_task / attempt / candidate` | 各自 UUID + task UUID | task/issue、candidate、run 三者同时匹配 |
| `factory_event` | task UUID + event UUID | 用复合 key；不按 eventId 全库猜测 |
| `acceptance` | deliverable acceptance ID，或既有批准 event key | 必须是同 task/candidate 的 Owner 事实 |
| `artifact_version` | Artifact UUID + version UUID；校验 version integer / sha256 | 用原有 Artifact ACL，显示精确版本；不引用可变 latestVersion |
| `pull_request / commit` | 已验证 remoteKey + PR number / 完整 commit SHA | 用已有仓库绑定；禁止任意 URL 抓取和含凭证 remote URL |
| `entire_checkpoint` | repository binding ID + backend + checkpoint ID + metadata commit SHA | 见 §5；读到 Git 数据并不自动证明发言者或 run 身份 |

`sourceRef` 是服务端生成的不透明 ID；对外链接从已经校验的定位器构建。历史删除后的来源返回 `unavailable`；当前读者无权限的来源不返回 ID、标题、摘要、计数或 URL，避免通过“打不开的节点”泄漏存在性。

### 3.4 Entire 索引和记录配置

#1246 增加以下事实/索引；它们不保存地图形状：

| 表 | 主要字段及唯一约束 | 目的 |
| --- | --- | --- |
| `project_repository_bindings` | `id, ownerId, workspaceId, projectId, remoteKey, repositoryId?, createdAt`；唯一 `(workspaceId, projectId, ownerId, remoteKey)` | 外部编码必须先有明确的项目—仓库绑定；复用 GitHub installation 验证，不增加 token 存储 |
| `repository_recording_settings` | `id, ownerId, workspaceId, bindingId, deviceRepoId?, targetKind, captureEnabled, publishEnabled, checkpointRemoteKey?, destinationVisibility, consentVersion, consentedAt, revision, appliedRevision, state, lastErrorCode` | 同意的目标是一个账号、设备/仓库和采集配置；desired/applied 分开，离线关闭不能谎报已生效 |
| `entire_checkpoint_index` | `id, bindingId, backend, checkpointRef, checkpointId, metadataCommitSha, entireCliVersion, formatVersion, sessions, occurredAt, importedAt, filePaths, transcriptAvailable, sourceDigest, redactionVersion, ingestStatus` | 只保留需要的安全元数据；唯一 `(bindingId, backend, checkpointId, metadataCommitSha)`，可从仓库重建 |
| `entire_checkpoint_links` | `checkpointIndexId, sessionId?, commitSha?, runId?, matchMethod, matchedAt` | 一个 checkpoint 可关联多个提交/执行；不用单个 nullable runId 假装一对一；规范化复合唯一 key |
| `entire_import_cursors` | `bindingId, backend, scanGeneration, observedRefsDigest, lastCompleteScanAt, continuationRef, legacyIndexedTipSha?, parserVersion, state, lastSuccessAt, lastErrorCode` | 去重、增量和失败恢复；不依赖某个浏览器一直打开 |

索引按 `bindingId+occurredAt+id`、`bindingId+checkpointId`、`commitSha`、`runId` 建 B-tree；文件列表限制长度，未在列表中读取全文、diff 或模型原始 JSON。索引更正以新的 metadataCommitSha/sourceDigest 留痕；同一个 ref 被强推时重新核对，不能把“已见过 checkpoint ID”当作永远不变。

### 3.5 迁移和历史项目

- #1244 **不增加 SQL、Drizzle schema、工具或生产配置**。
- #1245 创建决定与来源表；#1246 创建仓库设置和 Entire 索引；#1247 只新增被查询计划证明需要的索引。
- 遵循 `scripts/migrate.mjs`、`scripts/migration-steps.mjs`、`scripts/check-migrations.mjs` 及现有按库迁移清单；应用库默认 `MIKKA_DATABASE_URL`，工作区库 SQL 文件头使用 `-- target: DATABASE_URL`。普通文件整条事务执行；`CREATE INDEX CONCURRENTLY` 必须单独文件配 `-- migrate: no-transaction`，遵循已有 INVALID-index 恢复规则。迁移编号按 `docs/dev-workflow.md §6` 领取/协调，实施时不得硬占一个现在看起来空闲的时间戳。
- Drizzle 声明和 SQL 一起变更；以新增表/索引为主，兼容旧服务，实际部署经 `pnpm build` 的既有迁移流程。验证空库、已迁移库再执行、旧数据及并发重投；失败用修复 PR，不能手改生产 schema。
- 历史项目从现有 issue/run/Factory/Artifact 事实开始显示；`decision: null`、`reason: null` 表示无记录，不能自动编造“选择了 X 因为 Y”。
- 允许后续按需进行有来源的事后总结；记录为 `inferred` 并保存 inference source/version。打开地图不触发付费推断，也不批量回填整个历史库。
- 外部 checkpoint 没有关联 run 时保持 `runId: null`、`origin: external`，不是错误；来源或权限缺失则报告覆盖范围，不造一个假 run。

## 4. 谁写入、何时写入

### 4.1 一个服务层，四种入口

计划新增 `lib/project-map/decisions.ts`，供 MCP、bot 工具及 HTTP 路由共用。对外工具注册名为 `record_decision`；在 Mikka 工具命名空间中显示为 `mikka.record_decision`。

| 入口 | 可信身份 | 写入范围 |
| --- | --- | --- |
| Mikka bot（含 Coordinator） | host 构造的执行上下文、botId、真实 user/workspace | 当前项目/任务及它有权引用的消息；模型不能传另一个 ownerId 来切换身份 |
| Mikka 派出的 CC/Codex | `verifyRunToken` → `workerRun` + 冻结执行身份 | token 对应的 run、issue、Factory task 和项目；每次写复核租约、停止、撤销与当前成员资格 |
| 用户终端的 CC/Codex | 现有 MCP OAuth，`mcpUserId/mcpActor` | 用户确有权限的项目；没有 Mikka run 则 runId 必须为空。客户端可报告 harness/model，但 assurance 为 `client_reported`，不能伪装成 host_verified |
| 人的「记为决定」 | 正常登录 session / 已有合法作用域的 API 身份 | 服务端读取用户选择的原消息/批准事件，并验证其可见性；不接受客户端拷贝的一句话冒充原文 |

OAuth grant 没有固定 workspace 时，必须由 project binding 解析并逐次确认当前成员/任务权限，不依靠不存在的 grant 字段。已有个人 Coordinator 工具仍保持个人 workspace 行为。worker token 不能通过这个入口扩张到兄弟任务或另一个项目。

Bot 的 AI SDK 工具、`app/api/mcp/route.ts` 的 OAuth handler 和 worker handler 必须都注册；并纳入现有 Agent definition/tool catalog 与系统提示生成检查。补充 `lib/run-app-mcp.ts`、`lib/run-prompt.ts`、`workflows/coordinator/tools.ts` 的冻结工具目录，以及 daemon 的 `packages/daemon/src/agents/mikka-mcp.mjs` stdio 注册/launcher 注入。现有 verify_command 只在 stdio 的 factoryVerify 配置存在时提供；不能把它或任意日志当成 record_decision 已可用的证明。#1245 以各真实调用入口的 tools/list 与实际调用验证接线。

### 4.2 调用条件

必须记录的时点：

- 明确选择有实质取舍的方案，开始沿该方案执行之前。
- 停止一条已尝试的路线，记录停止位置、实际原因及继续路线。
- 修改原定架构、目标或实施方向；原决定保持可追溯。
- 人在对话、问题回答或验收中拍板；在场 bot 引用真实消息/事件记录。
- 两条实质路线合流；列明合流来源及可验证的 candidate/commit。

读文件、跑命令、改变量名、格式化、常规重试不记录为决定。供应商故障后按已有模型顺序换模型，属于执行恢复；除非同时改变项目方向，不新造方案分支。

工具返回持久化的 `decisionId`、`duplicate` 和写入时间；收到成功前 bot 不能宣称“已记录”。超时用原 idempotencyKey 查询/重试，不重复制造分叉；工具不可用时让 review 看见缺失，不能把没写入的决定当成已写入。

### 4.3 输入、幂等、来源和安全

- 不接收 `ownerId, recordedBy, recordedAt, hostVerified` 等可伪造字段。一次写入决定+来源在应用库事务内完成。
- 从 run 自动绑定 run、issue、Factory candidate；显式提供了冲突的 ID 就拒绝，不悄悄改成另一个对象。应用库写事务沿 `requireLockedIssueScope` 在锁后复核 scope/version，并重新检查 token/run 状态；不能把写入前的一次慢授权查询当成永久许可。
- host 的工具 call ID/消息操作 ID 作为幂等键；外部 MCP/HTTP 客户端提供稳定键。mask/规范化后计算 payloadHash，同键不同内容为 `IDEMPOTENCY_CONFLICT`。
- 已知 run 的文本经过 `maskForRun`；非 run 来源使用现有 owner secret masker 和通用模式脱敏。没有身份/secret scope 时拒绝复制原始敏感内容，不退回 identity masker。
- 限制字符串、options、source 数量；参数和 cursor 使用 schema 校验；任意 URL、repo path 和 Git 对象名不能进入 shell 拼接。
- 默认决定内容的可见范围不超过其来源。私有 run/chat 摘要继续 owner-only；workspace 读者最多看到现有政策允许的结构化状态。不能因为脱敏了就把私密原因共享出去。
- 不变更本次任务以外的账号/云/仓库权限，不引入新的长期 token 或另一套身份系统。

### 4.4 「记为决定」HTTP 接口

`POST /mikka/api/projects/:projectId/decisions/from-message`

请求：`{ workspaceId, source, title, summary, reason, kind, options, selectedOptionId, contextOptionRef?, idempotencyKey }`。`source` 是 §3.3 对应的强类型消息定位器（例如 `{type: "run_message", runId, messageId}` 或 `{type: "bot_message", botId, position}`）；不是任意 URL，也不要求原消息事先已有 decision sourceRef。服务端读取当前用户可见的原消息，提取作者、时间和定位器，写入后生成 sourceRef。模型改写的 summary 不冒充原话。群聊定位按实际 membership/message key 校验，不能只凭 botId 推定有权读取。

成功：201 `{ decisionId, duplicate: false, recordedAt }`；同键同 payload 重投：200，`duplicate: true`。401 未登录；不可见对象统一 404；400 字段错误；409 版本/幂等/归属冲突。该路由只写决定，不改原消息、不执行任务、不触发模型调用；前端按钮归 #1248。

另提供 `POST /mikka/api/projects/:projectId/decisions` 共用上述校验，允许人工写入项目级决定、经核实的事后推断或追加修正；禁止任意客户端把推断改成 host 当场记录。

### 4.5 漏记检查

在现有 Factory review 输入组装和普通 run 结束检查中，比较这次工作的事实与已有决定引用。Factory 结果沿 `lib/factory/reconcile-check.ts` 的冻结 task/attempt/candidate/run binding 处理，提示须经 `lib/factory/task-detail.ts` 暴露给调用方；不能只埋在内部 JSON。已有 review 调用内补一项检查，不为每个 chunk 额外调用模型。

1. 确定性信号：同 task 替换 thread、Owner 驳回后改变 candidate、明确 abandon/pivot 的问题回答、选项被废弃却没有关联决定。
2. 把新旧 candidate、任务范围变更、可见的相关消息，以及已有决定列表交给本来就运行的 review；语义判断可能报告 `possible_unrecorded_decision`。
3. 输出 `{code, severity: "warning", sourceRefs, explanation, relatedDecisionIds}`；属于 review 证据，不默认把整次验收判失败，也不自动替人补写“当场决定”。
4. 经调用者确认的补记使用 `provenance: inferred`；同 source digest/review attempt 去重。
5. 验证阳性（中途明确改向漏记）、阴性（仅重试/换模型/改格式）、已记录不重复提示、来源无权读取不泄漏。它是漏记提示，不能承诺识别所有自然语言中的暗含改向。


## 5. Entire 接入（#1246）

### 5.1 已核对的版本与格式

本 RFC 以 [Entire CLI v0.12.2](https://github.com/entireio/cli/releases/tag/v0.12.2) 为候选固定版本。已在 Docker Cloud Sandbox 下载官方 Linux amd64 发布包、按官方 `checksums.txt` 校验并运行 `version` 及命令帮助；包 SHA-256 为 `bfc5c8d5b599f328775b89b735db020c963e307b6a324fc30ce371fe8fa789e8`。正式发布按平台锁版本与校验和，不执行随时变化的远程 install script，也不静默升级到 Entire main。

上游依据：[README](https://github.com/entireio/cli/blob/v0.12.2/README.md)、[checkpoint 架构](https://github.com/entireio/cli/blob/v0.12.2/docs/architecture/sessions-and-checkpoints.md)、[ref backend](https://github.com/entireio/cli/blob/v0.12.2/docs/architecture/ref-checkpoint-backend.md)、[安全和隐私](https://github.com/entireio/cli/blob/v0.12.2/docs/security-and-privacy.md)、[MIT LICENSE](https://github.com/entireio/cli/blob/v0.12.2/LICENSE)。

| 事项 | 核查结论与实施约束 |
| --- | --- |
| 新仓库 checkpoint | 默认 `git-refs`；`refs/entire/checkpoints/<shard>/<id>` 指向 checkpoint commit；shard 是 ID 最后两位 |
| 旧仓库 | 没有 checkpoints 配置的仓库沿用 `git-branch`：`refs/heads/entire/checkpoints/v1`，checkpoint 位于树内分片路径；不得强制迁移用户历史 |
| checkpoint 和代码提交 | 代码提交的 `Entire-Checkpoint` trailer 是明确关联依据；可能多 session、多提交，也可能无代码提交的记录 |
| 机器读取 | `entire checkpoint list --json`、`entire checkpoint explain <id> --json --no-pager`；JSON envelope 不含 transcript，按需另取；不能解析人类表格 |
| 生成摘要 | `explain --generate` 会写摘要并花模型 token，地图读取/常规导入不用它 |
| CC / Codex hooks | CC 写 `.claude/settings.json`，Codex 写 `.codex/hooks.json`；不能因 CLI 安装完成就宣称 hooks 在实际 runner 配置下生效 |
| 无头启用 | 已配置 Git 作者身份时可用本地 Git 工作流启用，不要求新增 Entire 账号；缺少身份会导致非交互启用失败。只使用已授权 run 的仓库级 Git 身份，不修改 global config、不自动发起 Entire 登录 |
| 关闭 | `entire disable --local` 停止记录但保留 hooks。可另提供明确的卸载操作；`disable --uninstall` 会删除本地 metadata/session 等，不能当作普通关闭悄悄执行 |

新 ref 的树根包含 metadata/session/task 内容，不能套用旧 branch 树内分片路径。checkpoint ID 兼容旧格式及新 ULID，不能一律限定成 12 位十六进制。两个 backend 都要读。对 refs backend，**没有一个共享 branch tip**：导入游标存 `backend, scanGeneration, observedRefsDigest, lastCompleteScanAt, continuationRef`，逐 ref OID 对比索引；对旧 backend 才使用 `legacyIndexedTipSha`。§3.4 的 import cursor 字段按此区分，不得用单个 max checkpoint ID 或单个 branch tip 跳过并发记录。

### 5.2 三处安装与启用

| 运行位置 | 安装和启用位置 | 同意与配置边界 |
| --- | --- | --- |
| 本机 daemon | daemon 管理的私有工具目录保存固定 Entire 二进制；在已授权仓库/工作树启动 Agent 前检查版本和 hooks | **未经用户同意不下载、不安装、不改 hooks**。同意范围涵盖共享 Git common-dir 下相关 worktree；用户自己终端的接入也必须在该范围内 |
| 自管服务器 | 使用同一 daemon 工具管理和仓库启用逻辑；无 UI 部署可通过已认证管理接口提供同意 | 服务器仍是用户设备，不因“无头”自动获得改用户仓库的许可；不用 `sudo` 改全局 Git/CLI 配置 |
| E2B 任务机器 | `packages/daemon/scripts/official-e2b-instance-bootstrap.sh` / worker release payload，由 `lib/computer/official-runtime.ts` 的 `stageOfficialWorkerRelease` 校验；`lib/cloud-computer/thread-machines.ts` 启动新官方实例后安装 | 应用管理的临时任务仓库自动启用采集；远程发布仍受仓库 recording policy 控制。官方 `claude/codex/desktop` 模板及其原始文件保持不变 |

接入沿现有生命周期：`packages/daemon/src/worktrees.ts` 准备任务工作树，`src/agents/harness-home.ts` 创建隔离 CLI home，然后在 `src/subscription-local-runner.ts` / `src/subscription-hosted-runner.ts` 的实际 adapter.start 前执行同一套 capture setup。按 canonical Git common-dir 串行化 hook/config 写入，沿用 `withRepoConfig` 的协调方式。不得复制用户真实 CLI home、登录态、MCP 或个人历史来“补 hooks”，也不改变订阅凭证与工具审批生命周期。

E2B 的 stage 模式只放置并校验待启用 release，不安装 live hooks；真正启用沿既有维护租约、worker refresh，再到具体任务仓库执行。Coordinator 的临时上下文没有任务 repo/worktree，不对它执行 Entire enable；其决定工具沿 `job.tools` / `CoordinatorToolZod` / `coordinatorCommand` 协议注册。

在已配置 Git 身份、至少一个初始提交的授权仓库，首次启动指定 Agent 的基准命令为：

```sh
entire enable --agent claude-code --local --no-init-repo \
  --checkpoint-backend refs --skip-push-sessions --telemetry=false --yes
# 同一仓库也使用 Codex 时：
entire agent add codex
entire status --json
```

只使用 Codex 的仓库从 `--agent codex` 开始。已经启用的仓库用 `entire agent add` 补 Agent，用 `entire configure` 改非 Agent 配置；不以 `--force` 覆盖现有 hooks。保留用户已有后端、hook manager 和非 Entire 配置；无法安全合并就记录 setup 错误，不破坏用户 hooks。

`--local` **不意味着不改仓库文件**：agent hooks 仍写到项目的配置文件，Git hooks 可能影响共享 worktree。任务 worktree 的这些集成文件只能进入 Mikka 的控制范围，不能被 Agent 顺手提交成业务变更；处理机制与现有 run 的临时配置生命周期一起验收。外部终端的用户若自行提交共享 hooks，这是用户的独立选择。

当前 daemon 给 CC/Codex 使用临时 CLI 配置目录；必须用实际启动参数验证 repo hooks 能被读取。如果某一 CLI 配置模式绕过项目 hooks，就在该 runner 的临时配置内安装等效 hook，并验证它与用户终端仓库配置互不覆盖。**这是 #1246 的先行兼容性验收门槛，不能仅凭上游宣称支持便跳过。**

### 5.3 同意、关闭和卸载接口

`GET /mikka/api/devices/:deviceId/repos/:repoId/recording`

返回 `{captureEnabled,publishEnabled,state,consentVersion,revision,appliedRevision,lastErrorCode}`。state 为 `not_consented / applying / enabled / disabling / disabled / error`；公开接口不返回本机绝对路径。

`PUT /mikka/api/devices/:deviceId/repos/:repoId/recording`

请求 `{captureEnabled,publishEnabled,checkpointRemoteKey?,consentVersion,expectedRevision}`；仅设备及仓库 owner 可写，active workspace、device token/repo ownership 必须一致。启用必须由正常用户操作或已授权管理员动作产生，不能由模型自己调用后伪造“用户已同意”。

publishEnabled=true 时，destination 必须是 consent 绑定且已验证可写的仓库；改 destination 需更新 consent/revision，权限失败不能回退公开 origin，历史内容也不会随设置自动搬迁或撤回。返回中仅给规范化的仓库 key/visibility，不给带凭证 URL。

保存 desired revision 后，通过既有 daemon command 通道发送受限类型命令；daemon 根据已注册 repoId 找目录，客户端不能传任意 filesystem path。远端收到的是配置意图和 revision，不是任意 shell。

关闭先更新 desired=false、拒绝该设备后续新增采集上报，再由 daemon 执行 `entire disable --local` 并以 `status --json` 核实，成功才设置 appliedRevision/state=disabled。设备离线时保持 disabling/pending；用户终端中的本地 hooks 直到设备执行关闭才真正停止，界面不得提前显示关闭完成。关闭不删除已有 checkpoint 或用户自己的历史对话。

卸载是独立显式操作，报告会移除哪些本地 metadata/hooks；不能默认运行清理 shadow branches、`git gc --prune=now` 或删除远程 refs。

### 5.4 发布与导入

**发布顺序：** Agent 完成编码 → Entire 在 Git 提交上写 trailer/本地 checkpoint → 现有代码发布 → 对许可的 checkpoint destination 同步 metadata → 服务器验证远端 ref OID/commit → 导入索引 → 失效通知。代码提交成功但 checkpoint 未同步，返回 `index/publish: pending`，不能把代码 PR 成功当作 Entire 成功。

- 由 worker 在授权的发布流程中确认 checkpoint 去向；校验有效 remoteKey/installation/repository ID。不得向未绑定的 remote 或 arbitrary URL 推送。
- 采用上游现有 push/fetch 语义，显式检查 checkpoint queue/远端 ref。上游 checkpoint 推送失败可能不阻止代码 push，Mikka 必须单独保留错误及可重试状态。
- refs backend 只处理 `refs/entire/checkpoints/*`；legacy backend 只处理指定 checkpoint branch。禁止 `git push --mirror` 或把所有 `refs/entire/*`、旧 shadow branches 一并发布。
- 导入者是已验证的 daemon/worker 或拥有现有仓库权限的后台任务；先检查 binding，再列 ref 名称/OID，只获取新增/变化 checkpoint 元数据。读取来源是 Git 对象，不在应用服务器直接执行仓库内脚本。单条 checkpoint/task 损坏或 transcript 缺失时记录条目级状态并继续其它条目，整批游标只推进已核实部分。
- GitHub REST 若不能读取某个自定义 ref，就交给已授权机器使用 Git transport，并验证其声明的 SHA；不能默默回退成“没有记录”。不要求用户给新 token/Entire 云账号。
- `entire checkpoint list` 默认只看当前 branch，不能用它证明全仓库已覆盖；完整发现需枚举许可的 ref namespace 和 repo 的可见提交 trailer，再按 checkpoint ID 读取。
- 云端结束前执行有界 flush。若推送失败，利用现有线程机器 park/pause 和发布重试保留本地队列；新重试重新取得短期权限，不延长原 run token。任务关闭导致清理机器前先处理待发布记录；无法保存时明确记录 `unavailable` 和原因，不报告完整覆盖。保留策略见 §9。
- 不引入新 GitHub webhook。Mikka 派发任务在提交/发布/结束事件后收集；外部终端在已启用 hooks 产生 checkpoint 后，由 daemon 的既有事件/心跳任务队列请求增量导入；重连对账和用户显式刷新可补齐丢失事件。没有在线机器且没有已推到授权远端的数据时只能显示 pending。

### 5.5 和 Mikka 执行、提交、外部编码对齐

证据强弱按以下顺序，全部限定同 owner/workspace/project/repository：

1. worker 的已认证回执同时带 runId、原生 CLI session ID、checkpoint ID、代码 SHA、metadata SHA；服务端验证 run lease、仓库和提交对象，标 `host_receipt`。
2. 已验证代码提交的 `Entire-Checkpoint` trailer，与 `factory_candidates.sha` 或经验证的发布回执/run report 中的同一 SHA 对齐（现有 `run_publications` 本身没有 SHA 列，只能提供发布定位，不能凭 PR URL 认定具体提交），标 `commit_trailer`。
3. 同仓库、同原生 session ID，只在已有可信 run-session 记录和明确覆盖范围时关联；resume 可能跨多个 run，保留多对多，不只取第一条。单靠时间接近、Git author email 或模型自报 runId 不能升级成 verified。
4. 无 Mikka 执行的 checkpoint 建为 external 节点，runId 为空；Git author 仅为仓库声明信息，不映射成 Mikka 用户身份。外部 Agent 使用 MCP 写决定后，可显式引用该 checkpoint，仍由服务端验证 scope 和对象。

如果同一个仓库关联多个项目，只按明确 binding 和已有 issue/run/人工关联进入对应地图；不得把仓库所有 checkpoint 自动复制到每个项目。对未能消歧的记录保留仓库导入状态，等待指定 project；不丢弃、也不猜选最近活动的项目。

### 5.6 脱敏与公开仓库（需评审确认）

Entire 会把 Agent 对话写入 Git。自定义 refs 不是访问控制；代码仓库公开时，对话也可能公开。上游文本脱敏是尽力扫描，不能保证清掉个人信息、内部业务内容或图片；Mikka 事后脱敏也无法撤回已经 push 的 Git 历史。

建议：

- 云端和已获同意的设备可以自动本地采集；初始 `push_sessions=false`，发布目的地由明确的 repository recording policy 控制。
- 私有仓库可在该项目已有授权的私有 destination 发布；公开代码仓库优先使用用户**已有且明确授权的私有 checkpoint 仓库**。上游支持 `--checkpoint-remote github:owner/repo` 或已命名 remote；不自动创建仓库或扩大 GitHub App 权限。
- 如果 Alex 选择允许发布到公开仓库，必须有对此仓库/目的地/数据范围的明确同意，并先验证上游脱敏与 Mikka 已知 secret 检查。遇到图片或未能安全检查的内容，不静默公开；报告 `publish_blocked_privacy`，保留代码发布和本地记录。
- 应用 DB 不保存完整原始 transcript。只索引安全元数据；已绑定 run 用 `maskForRun`，导入后的摘要/选段再按 Mikka 规则脱敏。输出文件路径必须是 repo-relative，过滤凭证文件、绝对路径与符号链接逃逸。
- 对所有原始来源保留 owner/仓库读取权限，map 不代理 Entire 账号登录，也不使用 `explain --repo` 隐式接入另一个 Entire 控制平面。
- 不自动导入用户最近 30 天的历史 CLI 会话，不设置 `--import-history`；本轮作用域是用户明确启用后的仓库及已存在、可授权读取的 checkpoint。

这项确认是数据公开范围的产品选择，不是要求 Alex 决定安装脚本细节。未批准的公开发布策略不能在 #1246 偷偷默认开启。


## 6. 地图读取合同（#1247）

### 6.1 端点与共同约定

所有地址含现有 base path `/mikka`。服务端文件在 `app/api/projects/[projectId]/map/...`，浏览器通过既有 base-path helper 访问。返回 `schemaVersion: 1`，时间为 UTC ISO 8601，ID 为稳定不透明字符串。

| 方法与路径 | 用途 | 主要参数 |
| --- | --- | --- |
| `GET /mikka/api/projects/:projectId/map` | 首屏/连续分页/展开一个折叠分支 | `workspaceId` 必填；`limit=50`（1～100）、`cursor`、`laneLimit=3`（只能 2 或 3）、`branchId?`、`q?`、`filter=all\|mainline\|abandoned\|with_artifacts`、`from?`、`to?` |
| `GET /mikka/api/projects/:projectId/map/nodes/:nodeId` | 按需详情，包含六个固定 section | `workspaceId`、`snapshot` |
| `GET /mikka/api/projects/:projectId/map/path` | 从项目起点到选中节点的完整路径 | `workspaceId`、`nodeId`、`snapshot`；不受当前筛选隐藏的节点影响 |
| `GET /mikka/api/projects/:projectId/map/overview` | 全图 minimap、可见分支与时间密度 | `workspaceId`、`snapshot`、与列表相同的过滤条件 |
| `GET /mikka/api/projects/:projectId/map/sources/:sourceRef` | 原始来源定位和允许读取的安全片段 | `workspaceId`、有界分页；重新校验来源权限，不作为任意 URL 代理 |

GET 共享项目/来源鉴权。详情和 path 不把“nodeId 存在”当作有权限。请求只能访问一个 workspace/project，API 没有 `ownerId` 切换参数。不返回完整提示、订阅邮箱、模型凭证、服务器绝对路径、带 token 的 URL。

### 6.2 摘要 DTO

以下 TypeScript 是合同说明，不是本 PR 的实现代码：

```ts
type MapNode = {
  id: string; // project:<id> | issue:<id> | run:<id> | candidate:<id> |
              // decision:<id> | entire:<bindingId>:<backend>:<checkpointId> | end:<branchId>
  type: "project" | "task" | "run" | "candidate" | "decision" | "checkpoint" | "branch_end";
  title: string;
  result: string | null;
  status: "planned" | "active" | "waiting" | "completed" | "failed" | "abandoned" | "unknown";
  occurredAt: string;
  order: number; // 本 snapshot 的全图拓扑序，不因分页/筛选重编号
  branchId: string;
  lane: number | null; // 当前 laneLimit 下 0..limit-1；null 表示折叠
  detailAvailable: boolean;
  badges: { artifacts: number; pullRequests: number; checks: number; entire: number };
  decision: null | {
    id: string;
    provenance: "recorded" | "inferred";
    captureMode: "live" | "human_marked" | "reconstructed";
    selectedOptionId: string | null;
    options: { id: string; title: string; disposition: string; reason: string | null }[];
    reason: string | null;
    sourceRefs: string[];
  };
};

type MapEdge = {
  id: string;
  from: string;
  to: string;
  kind: "continues" | "fork" | "merge" | "depends_on";
  evidence: "declared" | "host_verified" | "inferred";
};

type MapBranch = {
  id: string; // main:<projectId> 或 option:<decisionId>:<optionId>
  parentBranchId: string | null;
  forkNodeId: string | null;
  optionRef: { decisionId: string; optionId: string } | null;
  status: "active" | "completed" | "abandoned" | "not_taken" | "unknown";
  stoppedAtNodeId: string | null;
  reason: string | null;
  sourceRefs: string[];
};

type MapPage = {
  schemaVersion: 1;
  snapshot: { id: string; expiresAt: string; layoutVersion: 1 };
  coverage: {
    decisions: "recorded" | "partial" | "none";
    entire: "ready" | "pending" | "disabled" | "partial" | "unsupported";
    lastIndexedAt: string | null;
  };
  nodes: MapNode[];
  edges: MapEdge[];
  branches: MapBranch[];
  mainlineBranchIds: string[]; // 已选路线的有序链/集合，不是单个 branchId
  boundaryNodes: { id: string; order: number; lane: number | null }[];
  laneState: {
    before: { branchId: string; lane: number }[];
    after: { branchId: string; lane: number }[];
  };
  focus: null | { branchId: string; breadcrumbs: { branchId: string; forkNodeId: string }[] };
  folds: {
    id: string;
    parentBranchId: string;
    anchor: { nodeId: string; order: number; lane: number }; // 可见父路线上的折叠行，lane 不越界
    branchIds: string[];
    orderStart: number;
    orderEnd: number;
    nodeCount: number; // 仅已授权且符合筛选的节点
    expand: { branchId: string };
  }[];
  page: { nextCursor: string | null; hasMore: boolean; matchedCount: number };
};
```

枚举值在 OpenAPI/共享 Zod 合同中统一；`failed` 是执行结果，`abandoned` 是路线结论。默认字段不能省略成不同客户端各自猜测的语义；无结果为 null，不返回“成功”等替代文案。source 对象不直接内嵌完整对话。

### 6.3 从事实构图，不把顺序当因果

1. 用已经通过权限检查的 project→issue 集合作为范围；批量读取运行摘要、Factory 版本/事件、决定及 Entire 索引。历史数据无记录时明确 unknown。
2. 优先采用明确决定的 `contextOptionRef`、predecessor、branch-work/merge 引用构造路线。按有效的追加决定投影 option 的当前状态：后来的 abandon/merge 引用原 contextOptionRef 改变路线结论，原 choose.options 保持当时内容；supersedes/retracted 按修正链处理，不能原地改写过去。任务的 parent/blockedBy 仍为组织/依赖关系，不自动选择其中一个任务作为被放弃的方案。
3. `retryOf/continuesRunId` 和同候选 review/verify 表达执行延续；`threadReplacedBy` 表达被替换事实。只有相关决定/已验证终止事件能把路线标成 abandoned。旧 candidate 不是当前 candidate，不等于已放弃。
4. 已获采用的 candidate 只在对应的 acceptance/merge 证据存在时接回已选路线；未采用但成功产出仍保留。Git commit 的两个 parent 是 Git 合并事实，若不能映射到项目路线，就只显示在代码详情，不虚构项目合流。
5. 每个没有明确前驱的独立工作挂在项目根节点下，保持 unknown lineage；时间只排序，不推断“上一条就是原因”。
6. `contextOptionRef` 继承沿 `continuesRunId/retryOf` 到后续 run；同一时间多个相关决定冲突时返回 unknown 分配并在详情列出证据，不能按最近时间随意选。任意手动引用都需验证同 scope。
7. 先做稳定拓扑排序：前驱优先；同时可排序的节点按可信 occurredAt、source 类型、稳定 ID 排序。未来时间/时钟偏差单列来源时间，不把图排成回边。依赖循环不拖垮地图；它不加入路线 DAG，并返回可诊断的 coverage 问题。
8. 全图只有一套稳定语义 ID。节点标题、状态和具体 lane 可随新 snapshot 更新，ID 不随分页、宽度、候选状态或来源修正变化。

### 6.4 lane、折叠、放弃和跨页连接

- lane 0 保留为主线。**每个 option 都有独立的 `option:<decisionId>:<optionId>` 语义 branchId**；selected option 只继承父路线当前 lane，由 continues 边连接，不能复用父 branchId。mainlineBranchIds 是明确选择构成的历史路线链/集合。后续 abandon(context=D1.A)、redirect 选择 C 分别作用于 A、C，能够同时返回 A 已放弃而 C 活跃，项目根和共用历史不被一并改成 abandoned。其余 option 依稳定 option ID 顺序，分配**父 lane 右侧最小的空闲 lane**。
- laneState 记录当前可见的末端路线占用；selected 子路线接管父路线的同一 lane，是路径延续而非并行占用。并行 active 路线之间不复用 lane；只有明确完成、合流或放弃后的行之后才能把 lane 释放给另一条并行路线。失败但仍等待处理的 run 不释放整条路线。
- 显示预算由 `laneLimit` 指定：桌面 3、手机 2。没有右侧空 lane 的路线作为 fold 返回，不能挤进父 lane、删掉或按页截断。
- 超预算的路线在该 snapshot 中整条折叠，不在后面的某页突然冒到另一条 lane。fold 的 ID 由父路线、被折叠路线集合和 layoutVersion 决定，anchor 位于可见父路线内；多条隐藏路线的聚合 fold 列出 branchIds，用户选择其中一条再用 expand 请求。带 `branchId` 请求独立子图时选中路线成为局部 lane 0，返回 focus.breadcrumbs 供定位原分叉。语义节点 ID 不变。
- 放弃路线返回真实 `stoppedAtNodeId` 和理由来源；若只有“未采用”，终止点是决定节点；无法知道停在哪则 null，不猜最后一个失败 run。
- 首屏之后的分页返回 `laneState.before/after` 和 `boundaryNodes`，使分页两侧的连线不断开。边的另一个端点必须位于 nodes 或 boundaryNodes；非授权端点绝不作为 boundary 返回。
- 选择节点时 path 接口返回路线祖先节点/边 ID、选中的 option、合流的多条祖先链以及折叠分支展开定位。dependency 边不算历史路径。
- 多个前驱合流时不存在唯一一条历史路径；接口返回所有有证据的祖先路线，同时标出 `primaryPathNodeIds` 作为主线高亮顺序。前端不必自行猜哪条边是真正选择。

### 6.5 筛选、搜索和分页一致性

`q` 最多 200 字符，只搜索已获授权的标题、结果、决定理由、Artifact 名称和安全文件路径，不搜索原始 transcript、private prompt 或凭证。首版对几百/一千个投影节点做内存规范化子串匹配，覆盖中英文；不引入外部搜索服务或 pg_trgm 扩展。

`mainline` 取 mainlineBranchIds 指定的已选路线链/集合及其共同前驱；`abandoned` 取明确放弃/未采用的路线及其分叉定位；`with_artifacts` 只计实际可见的 Artifact。筛选后的 nodes 只包含命中项，但保留其原始 order/lane，并以 boundary/fold 定位到全图。筛选不重新分配 lanes，也不会让路径接口丢掉被筛掉的祖先。互斥 filter 用单一枚举，避免前端组合出含义不明确的条件。

**游标方案：**

- 首次查询读取轻量源事实集合并计算 fingerprint：project revision、授权后实际影响节点/边的 source ID、状态、结果和来源版本摘要、Factory revision、决定集合摘要、Entire import revision/ref OID、权限作用域版本。不把 heartbeat、token 续期和每个 stream chunk 的更新时间算成地图版本；active run 的 result 在没有稳定结果时为 null。不能只用一个 max(timestamp)，因为删除、中途插入和旧记录修改都会漏掉。
- 使用签名的不透明游标包含 `viewerId, workspaceId, projectId, fingerprint, filtersHash, laneLimit, layoutVersion, lastOrder, lastNodeId, expiresAt`，有效 10 分钟。签名由服务端现有 secret 使用 `project-map-cursor:v1` 域隔离派生；不把 secret 放进 token。
- 下一页重新构造同 scope 的轻量投影；fingerprint 或筛选/宽度不一致，返回 **409 `MAP_SNAPSHOT_CHANGED`** 和 `restart: true`。前端保留旧画面再取首屏，不把旧页和新页拼接。
- 失效 token 为 410 `MAP_SNAPSHOT_EXPIRED`；签名/结构错误为 400；跨 reader/workspace/project 或已撤销权限为 404。鉴权先于内容和总数计算。
- 两个数据库不具备统一 MVCC snapshot：应用库元数据读取用短只读事务，工作区/项目/权限版本在读取前后复核；变化时至多重读一次，再返回 409。不能把分布式竞态写成“绝对快照一致”。
- 服务端不持久化图副本；snapshot.id 是不透明、签名且绑定调用主体/scope/查询的版本 token；detail/path/overview 每次以它复核相同 fingerprint，不是任意客户端可填的哈希。Entire 新记录到达或实际状态改变时，版本改变是预期行为。

### 6.6 详情、原始来源与 minimap

节点详情包含以下固定顺序，section 内不允许自由文本突破原来源 ACL：

```ts
type MapNodeDetail = {
  schemaVersion: 1;
  snapshotId: string;
  node: MapNode;
  sections: [
    { kind: "tasks"; items: { id: string; title: string; status: string; href: string }[] },
    { kind: "decisions"; items: { id: string; kind: string; title: string; summary: string; reason: string | null; options: DecisionOption[]; selectedOptionId: string | null; provenance: "recorded" | "inferred"; captureMode: "live" | "human_marked" | "reconstructed"; occurredAt: string; recordedAt: string; sourceRefs: string[] }[] },
    { kind: "artifacts"; items: { id: string; versionId: string; title: string; mediaType: string; href: string }[] },
    { kind: "checks"; items: { attemptId: string; candidateId: string; runId: string | null; stage: "review" | "verify"; status: string; reason: string | null; checkedAt: string | null; sourceRefs: string[] }[] },
    { kind: "conversation_summary"; items: { text: string; provenance: "recorded" | "inferred"; sourceRefs: string[] }[] },
    { kind: "threads"; items: { rootRunId: string; harness: string | null; status: string; href: string }[] }
  ];
  references: {
    runs: { id: string; rootRunId: string; href: string }[];
    pullRequests: { repositoryKey: string; number: number; url: string; commitSha: string | null }[];
    entire: { sourceRef: string; checkpointId: string; metadataCommitSha: string; href: string }[];
  };
};
```

实现共享 schema 时复用现有安全状态枚举，按上方字段明确投影，不直接透传数据库 JSON。必要信息包括：task ID/标题/状态，decision 的完整 §3.2 可见投影，Artifact ID/versionId/标题/媒体类型/授权链接，check 的 attemptId/candidateId/runId/阶段/结论/理由/证据时间，对话 summary 的 `text, provenance, sourceRefs`，thread 的 rootRunId/实际 Agent/状态/链接。不存在可用摘要时为空数组，不在 GET 内临时问模型。

详情中私有部分以空 section 返回；只有 section 本身已知可见、内容因删除或抓取失败不可用时，才能附 `unavailable` 原因。不要给无权限者返回“还有 N 条私密对话”。

路径与 minimap 采用下列同版本合同；完整 DAG 的节点定位只含有界元数据，不含正文：

```ts
type MapPath = {
  schemaVersion: 1;
  snapshotId: string;
  targetNodeId: string;
  nodes: { id: string; order: number; branchId: string; lane: number | null }[];
  edges: MapEdge[];
  primaryPathNodeIds: string[];
  selectedOptions: { decisionId: string; optionId: string }[];
  expand: { branchId: string; forkNodeId: string }[];
};
type MapOverview = {
  schemaVersion: 1;
  snapshotId: string;
  totalVisibleNodes: number; // 当前授权的完整图
  matchedCount: number;      // 当前筛选命中
  range: null | { fromOrder: number; toOrder: number; fromTime: string; toTime: string };
  bins: { fromOrder: number; toOrder: number; nodeCount: number; branchIds: string[]; hasAbandoned: boolean; hasArtifact: boolean }[];
  branches: MapBranch[];
  mainlineBranchIds: string[];
  branchLinks: { fromBranchId: string; toBranchId: string; atOrder: number; kind: "continues" | "fork" | "merge" }[];
  laneSegments: { branchId: string; fromOrder: number; toOrder: number; lane: number | null; foldId: string | null }[];
  folds: { id: string; anchor: { nodeId: string; order: number; lane: number }; orderStart: number; orderEnd: number; branchIds: string[] }[];
};
```

overview 的 laneSegments/folds/branchLinks 是同 snapshot、laneLimit、focus 的完整安全布局骨架，数量受可见节点规模约束；不含正文，无需前端加载全量分页或重写布局算法。overview 按全局 order/time 范围聚合最多 100 个 bin；它不是另一次未授权的 COUNT。筛选保留全图范围与布局坐标，bin.nodeCount 只计命中；请求过滤条件必须与 snapshot 相同。path 返回目标的全部因果祖先并集，父子通过实际 edge 关联；primaryPathNodeIds 只在明确选择关系可确定时给出，不能用最近时间替多父合流任选一条。全图规模在首版几百/一千节点范围内；不得截断祖先链并声称完整。

### 6.7 权限、性能和刷新

HTTP 适配复用现有 API 的 session/token 解析、日志与 `Cache-Control: private, no-store` 约定；完整保留 `[tokenWorkspace]` principal，禁止降成裸 `user.id` 后丢失 PAT 的 workspace 限制。nodeId/sourceRef 进入 URL 时需要编码。

**权限顺序：** 验证 session/token → 选定 workspace 且 active membership → 验证项目归属/共享资格 → task ACL → run/Factory/Artifact/原对话/仓库 ACL → 构图、搜索、计数。项目 owner 并不自动拥有其他成员私有 run 的完整内容，workspace admin 也没有这种越权读取路径。复用 `workspaceRunView` 的安全结构化状态投影；不得直接 select 原始 report/message JSON 回给团队成员。

所有详情、source、path、overview、分页、Entire 导入以及决定写入都测试跨 owner、跨 workspace、被移除成员、被撤销仓库授权。cursor 缓存或 sourceRef 不是访问凭证；日志只记录 request ID、错误代码、耗时和数量。

**性能目标（待 #1247 实测，非本 RFC 的成绩）：**

| 情况 | 目标 |
| --- | --- |
| 500 个可见节点，第一页 50 条 | 同区热请求 p95 ≤ 500ms；生产端到端单列统计 |
| 1,000 个可见节点，分页/筛选/overview | 同区热请求 p95 ≤ 1s |
| 单节点详情，不含原始 transcript | p95 ≤ 500ms |
| 默认列表响应 | gzip 后 ≤ 150 KiB；不得带全文 transcript |
| 查询量 | 固定批量查询，初版目标 ≤ 12 次数据库往返；不随节点数产生 N+1 |

先在权限范围内只取摘要列，Artifact/PR/check 聚合批量取，整个轻量图只在内存里短暂存在；原始对话分段按需读取，每次最多 100 条或 256 KiB，超出返回 continuation，不能静默截断成“完整”。

新增 `project_map` 失效 kind，沿用 `lib/live/events.ts` 的 `{kind,id}` 协议及既有 scoped channel。决定提交、checkpoint 索引提交、project/issue 关系改变和影响地图的 Factory/run/Artifact 状态提交后合并发送失效通知；回滚不推送。需同步 server 与 gateway 的 allowlist/合同，不能只在应用侧新增枚举。共享内容通知只发给已有权限对应的 channel，不携带节点标题和对话。

通知丢失沿用已建 live 通道的断线/重新连接对账策略；地图不新增高频轮询、不注册一个每节点定时器。GET 的内容版本与 ETag 承担最终一致性，不能只靠一次推送保证永远最新。


## 7. 前端对照与示例

### 7.1 父 issue 每条要求的落点

| #1243「前端要的形状」 | 后端合同 |
| --- | --- |
| 项目地图标签页 | 按 projectId/workspaceId 读取，无新全局入口；#1248 负责 UI |
| 竖向主线和分叉 | stable node ID、全局 order、continues/fork/merge 边、branchId、lane |
| 嵌套分叉、选中方案留原道、结束后复用 | §6.4 确定性分配；明确 contextOptionRef，lane 只在有终止证据后释放 |
| 桌面 3 道、手机 2 道、深分支折叠 | laneLimit 2/3、folds 和 branchId 子图请求 |
| 放弃路线保留、停在哪、为什么 | branch status、stoppedAtNodeId、reason、sourceRefs；样式由前端处理 |
| 选节点高亮从起点到它的路径 | path 返回 primaryPathNodeIds 及全部路线祖先，跨分页/折叠 |
| 右侧/手机抽屉详情的六个区域 | 固定 tasks → decisions → artifacts → checks → conversation_summary → threads |
| 缩略图 | overview 有界 bins、laneSegments/folds/branchLinks 完整布局骨架、相同 snapshot/laneLimit/focus |
| 搜索、只看主线/放弃/有产出 | q 与 filter、scope 内搜索计数；过滤不重排 lane |
| 理由、当场/推断区分、原始来源链接 | decision.provenance、reason、validated sourceRefs；人工标记保留独立入口来源 |
| 产出、PR、检查、执行、Entire | 列表 badges + 详情 references + 精确 candidate/version/source IDs |
| 几百节点分段取与筛选 | 有界 limit、签名 cursor、boundaryNodes/laneState、409 刷新语义 |

### 7.2 示例响应

**这是合同示例，ID 和时间是虚构的，不是生产验收结果。** #1247 上线后必须用真实项目的脱敏响应替换交接评论中的示例；opaque 字符串仅代表服务端签名 token。

请求：

```http
GET /mikka/api/projects/00000000-0000-4000-8000-000000000001/map?workspaceId=00000000-0000-4000-8000-000000000002&limit=2&laneLimit=3&filter=all
```

响应（展示一个决定和指向后页的边）：D1 当时保留了备选路线，后续独立的 abandon 决定使该路线停止；因此 D1.options 仍为 retained，branch 当前状态为 abandoned。后续决定及其 source:…202 在详情/后页读取，不回写 D1 的历史。

```json
{
  "schemaVersion": 1,
  "snapshot": {
    "id": "opaque-signed-snapshot",
    "expiresAt": "2026-11-04T18:50:00Z",
    "layoutVersion": 1
  },
  "coverage": {
    "decisions": "recorded",
    "entire": "partial",
    "lastIndexedAt": "2026-11-04T18:39:00Z"
  },
  "nodes": [
    {
      "id": "project:00000000-0000-4000-8000-000000000001",
      "type": "project",
      "title": "项目地图示例",
      "result": null,
      "status": "active",
      "occurredAt": "2026-11-04T17:59:00Z",
      "order": 0,
      "branchId": "main:00000000-0000-4000-8000-000000000001",
      "lane": 0,
      "detailAvailable": true,
      "badges": {
        "artifacts": 0,
        "pullRequests": 0,
        "checks": 0,
        "entire": 0
      },
      "decision": null
    },
    {
      "id": "decision:00000000-0000-4000-8000-000000000101",
      "type": "decision",
      "title": "选择项目地图的数据来源",
      "result": "采用当场记录，历史总结作为补充",
      "status": "completed",
      "occurredAt": "2026-11-04T18:00:00Z",
      "order": 1,
      "branchId": "main:00000000-0000-4000-8000-000000000001",
      "lane": 0,
      "detailAvailable": true,
      "badges": {
        "artifacts": 1,
        "pullRequests": 0,
        "checks": 0,
        "entire": 0
      },
      "decision": {
        "id": "00000000-0000-4000-8000-000000000101",
        "provenance": "recorded",
        "selectedOptionId": "record-now",
        "options": [
          {
            "id": "record-now",
            "title": "当场记录",
            "disposition": "selected",
            "reason": null
          },
          {
            "id": "reconstruct-later",
            "title": "只在事后总结",
            "disposition": "retained",
            "reason": null
          }
        ],
        "reason": "把决定与当时的证据一起保存",
        "sourceRefs": [
          "source:00000000-0000-4000-8000-000000000201"
        ],
        "captureMode": "live"
      }
    }
  ],
  "edges": [
    {
      "id": "continues:project:d101",
      "from": "project:00000000-0000-4000-8000-000000000001",
      "to": "decision:00000000-0000-4000-8000-000000000101",
      "kind": "continues",
      "evidence": "declared"
    },
    {
      "id": "fork:d101:later",
      "from": "decision:00000000-0000-4000-8000-000000000101",
      "to": "run:00000000-0000-4000-8000-000000000301",
      "kind": "fork",
      "evidence": "declared"
    }
  ],
  "branches": [
    {
      "id": "main:00000000-0000-4000-8000-000000000001",
      "parentBranchId": null,
      "forkNodeId": null,
      "optionRef": null,
      "status": "active",
      "stoppedAtNodeId": null,
      "reason": null,
      "sourceRefs": []
    },
    {
      "id": "option:00000000-0000-4000-8000-000000000101:record-now",
      "parentBranchId": "main:00000000-0000-4000-8000-000000000001",
      "forkNodeId": "decision:00000000-0000-4000-8000-000000000101",
      "optionRef": {
        "decisionId": "00000000-0000-4000-8000-000000000101",
        "optionId": "record-now"
      },
      "status": "active",
      "stoppedAtNodeId": null,
      "reason": null,
      "sourceRefs": [
        "source:00000000-0000-4000-8000-000000000201"
      ]
    },
    {
      "id": "option:00000000-0000-4000-8000-000000000101:reconstruct-later",
      "parentBranchId": "main:00000000-0000-4000-8000-000000000001",
      "forkNodeId": "decision:00000000-0000-4000-8000-000000000101",
      "optionRef": {
        "decisionId": "00000000-0000-4000-8000-000000000101",
        "optionId": "reconstruct-later"
      },
      "status": "abandoned",
      "stoppedAtNodeId": "run:00000000-0000-4000-8000-000000000301",
      "reason": "无法稳定还原当时未说出的取舍",
      "sourceRefs": [
        "source:00000000-0000-4000-8000-000000000202"
      ]
    }
  ],
  "boundaryNodes": [
    {
      "id": "run:00000000-0000-4000-8000-000000000301",
      "order": 2,
      "lane": 1
    }
  ],
  "laneState": {
    "before": [
      {
        "branchId": "main:00000000-0000-4000-8000-000000000001",
        "lane": 0
      }
    ],
    "after": [
      {
        "branchId": "option:00000000-0000-4000-8000-000000000101:record-now",
        "lane": 0
      },
      {
        "branchId": "option:00000000-0000-4000-8000-000000000101:reconstruct-later",
        "lane": 1
      }
    ]
  },
  "folds": [],
  "page": {
    "nextCursor": "opaque-signed-cursor",
    "hasMore": true,
    "matchedCount": 8
  },
  "focus": null,
  "mainlineBranchIds": [
    "main:00000000-0000-4000-8000-000000000001",
    "option:00000000-0000-4000-8000-000000000101:record-now"
  ]
}
```

验收 fixture 至少还包括下列结构；同一份源事实分别测 laneLimit=3 与 2：

| 顺序 | 事实 | laneLimit=3 | laneLimit=2 |
| --- | --- | --- | --- |
| 0 | 项目根 | lane 0 | lane 0 |
| 1 | D1 选择 A，保留 B 尝试 | A 留 0，B 开 1 | 同左 |
| 2 | B 内 D2 选择 B1，尝试 B2 | B1 留 1，B2 开 2 | B2 折叠 |
| 3 | B2 明确放弃，有停止 run 和理由 | 终止点占 2，此行后释放 | 折叠中仍保留终止与理由 |
| 4 | B1 内 D3 又试 B3 | B3 复用 2 | B3 可单独展开，不覆盖 B2 |
| 5 | B1 的成果明确合并到 A | merge 边回 0，1 在此行后释放 | 同一条真实合流 |
| 6 | 选择 B3 的历史节点 | path 保留 D1/D2/D3 及对应来源 | 自动提供要展开的 fold 定位 |
| 7 | 新外部 checkpoint，无 run | external checkpoint，runId=null | 相同语义 ID |

另测 D1 选 A → A 明确放弃 → D2 redirect 选 C：A/C 语义 branchId 不同但可沿同一 lane，A 的停止理由和 C 的 active 状态同时保留，不污染项目根。每个分页位置都切一遍，验证相邻页边界、lane 释放和路径一致；不把这一 fixture 当作生产真实任务。

## 8. 分步上线、验收和交接

### 8.1 #1244：文档评审

本 PR 仅改此文件。人工逐条对照 #1243/#1244～#1247、检查源码关联、校验 JSON 示例和文档 diff；CI 按当前 `scripts/ci-docs-only.mjs` 运行文档门禁，重型 unit/database suite 按仓库规则跳过。

**Alex 在 PR 上通过之前不合并、不开始实现。** 通过后由负责人确认最新 head 的适用检查全绿及可合并，squash 合并，再回 #1244 记录 PR/merge commit/剩余步骤。合并后仍按本任务要求跟踪 Web deploy、核对生产 `/mikka/api/version.build` 与合并 SHA。若 docs-only 被既有 workflow 跳过导致二者不相等，明确报告此项尚未满足，检查既有受支持的部署入口；不能用旧 build 冒充通过，也不擅自改 CI/deploy 规则。后续实现 PR 同样要求精确版本核对。

### 8.2 #1245：决定写入

1. 新表/迁移、共用写入服务、OAuth MCP/worker MCP/bot 工具、人工接口、提示和漏记检查同一个可评审后端 PR。
2. 在 Docker Cloud Sandbox 的独立数据库和正常 TestAccountPool 会话验证：三类 AI 调用入口、手动原消息定位、字段上限、幂等重投/冲突、并发修正、来源不存在、跨 run/owner/workspace、成员撤销、停止/过期 token、masking。
3. 真实本地 API/CLI flow：bot 讨论选方案，派 CC/Codex 做任务，中途一次明确改向，工具实际写入并可由 owner 读取；相同会话的工具 trace、决定行、origin source 定位一致。
4. 最新 head 适用 CI 全绿后 squash；跟踪 GitHub Actions Web deploy 完成，生产 `/mikka/api/version.build` 精确等于合并提交，再开始此版真实生产验收。
5. 生产两个订阅各做一项真实工作，记录 host 订阅 claim、run ID、实际模型、工具 call、decision ID、改向原消息、来源和时间；bot 另记一次决定。运行路径矩阵见 §8.5。

### 8.3 #1246：Entire

1. 固定版本/校验和、daemon 仓库同意 API、云端 worker 发布、增量导入与安全读取作为独立 PR；沿用 `e2b-official-runtime.yml` 验证官方实例/发布配置，不手改生产模板变量。
2. 本机和服务器：未经同意时无安装/配置写入；同意后仅改授权仓库，保留已有 hooks；两种实际 CLI 配置都捕获；关闭后新 turn 不再记录；离线关闭为 pending；重复启用/关闭不破坏配置。
3. Git fixtures：两个 backend、多个 checkpoint/session/run、同 checkpoint 多提交、无 Mikka run、ref 更新/强推、重复导入、丢失通知重连、错误/超大 JSON、被撤销仓库权限；保留敏感内容的负例且不输出真实 secret。
4. 云端 CC、Codex 分别跑生产真实 E2B 任务：新官方实例 → worker release → 原生订阅 claim → 至少一个真实 Git 提交 → trailer → 远端 checkpoint ref/object → 后端索引 → 正确 run/commit 关联。三处“安装完成”和“确实产生/读到记录”分别出示证据。
5. 验证用户终端在 Mikka 外写代码、已接入 Mikka MCP 记录决定后，两种事实能关联；没有 run 的记录仍显示 external。
6. checkpoint push 失败、机器暂停/恢复与任务清理不能伪装为成功；观察 checkpoint 同步状态与代码 PR 状态独立。
7. 合并/部署/版本确认同 #1245；现场跑过的 CLI 配置测试不代替真实模型/提交/远端数据验收。

### 8.4 #1247：读取与前端交接

1. 基于 #1245 和 #1246 已在生产产生的数据实现 graph projection、各读取接口、共享 schema、失效通知及索引；不复用 WIP 中未验权的 join。
2. 单元/数据库/API 测试覆盖：明确分叉、嵌套、abandoned/not_taken、真实 merge、无原因历史、外部 checkpoint、源删除、重复 ingestion；两个 laneLimit、所有筛选、page boundary、path/minimap、scope 撤销、snapshot 变化。
3. 生产 owner 真实项目必须有分叉、放弃原因、当场决定、Artifact、同候选检查和 Entire；逐项对照 DB/仓库，不能只用写死 JSON 演示。
4. 500/1,000 节点的性能项目在隔离环境可用可重复 fixture；生产另测已有几百节点的授权项目，记录实际数量、region/冷暖状态、请求次数、p50/p95、响应体大小。若尚无这样规模的生产项目，只能标此项未完成，不批量污染生产数据伪造指标。
5. 生产 API 版本验证后，在 #1247 评论写清：接口路径、请求/响应、**真实项目脱敏 JSON**、cursor/409、lane/fold/path、权限/已知限制、验证 revision 和证据。然后在 #1243 写「**后端已完成，可以开始前端**」。
6. 前端交接前没有通过的限制必须写明；不能将 RFC、WIP 或单元测试结果称为后端已上线。

### 8.5 三条真实模型路径独立记录

| 路径 | 固定模型 | 必须记录的真实证据 | 外部阻塞时 |
| --- | --- | --- | --- |
| API key | `deepseek-flash` | 调用前 `node scripts/assert-test-model.mjs deepseek-flash`；实际 key claim、run、决定/Entire/地图记录 | 余额/限流/服务故障记录真实错误并标 BLOCKED，继续另外两条；不以模型列表可读宣称能调用 |
| Claude Code 官方订阅 | `claude-haiku-5-5` | 原生订阅 claim、原始 run/session、工具调用、提交和 checkpoint | 不切到 API 或其他模型凑通过 |
| Codex 官方订阅 | `gpt-6-luna` | 原生订阅 claim、原始 run/session、工具调用、提交和 checkpoint | 同左 |

内部 Decision 裁判沿用现有 `DECISION_MODEL`，不属于被测编码模型替换。每条为 PASS / FAIL / BLOCKED，不能把一条 PASS 合并成“三条通过”。产品自身的问题必须修复产品后重跑；余额等外部原因才是 BLOCKED。

每个子 issue 的评论模板：**PR / merge SHA；适用 CI 和部署 run；生产版本及核对时间；本路径结果和证据；其他两条路径结果；还剩什么**。明确的外部阻塞不阻止其余两条发版；未完成项保留在 issue 或链接的补验项中，不能在关单时消失。

## 9. 风险和需要 Alex 拍板的问题

### 9.1 需要本次评审确认

| 选择 | 推荐方案 | 影响 |
| --- | --- | --- |
| **公开代码仓库的完整编码对话发布到哪里？** | 使用已经授权的私有 checkpoint repository；无私有目的地时只采集到本地，地图显示 pending/metadata 覆盖范围。公开上传需单独、针对该仓库的明确同意 | 遵守“完整过程可追溯”同时避免把对话意外永久公开；不能承诺只靠正则脱敏安全。若要新建私有仓库/扩大 GitHub App 安装范围，实施时按授权规则单独说明目标 |
| **云机器即将被清理但 checkpoint 尚未同步时如何保留？** | 普通完成先沿用现有 pause，保留队列；已关闭/删除任务的清理给予一次有界、重新授权的同步机会，仍失败则明确显示缺失，不无限保留付费运行机器 | 默认不让 Entire 故障阻塞代码交付；需要接受极端外部故障下存在记录缺口。如果要求此类情形绝不丢失，需再定义私有持久存储和保留/删除政策，不能悄悄多造存储系统 |

本 RFC 的权限、幂等、lane 和游标选择是具体工程方案，随整份 RFC 评审；没有额外要求 Alex 决定的库/算法/安装脚本选型。**评审通过前，上表推荐也只是提案。**

### 9.2 实施风险与处理

| 风险 | 现实触发路径 | 处理 / 验证 |
| --- | --- | --- |
| 把失败当作放弃 | 模型 429、基础设施重试、旧候选被替换 | 使用明确语义事实；对应反例进入 graph 测试 |
| 漏记、错误归因 | 人临时拍板、外部 CLI 无 MCP、模型未调用工具 | provenance、source linkage、review warning；不事后伪造当场记录 |
| 私有内容通过共享项目泄漏 | 项目可读而私有 run/chat 不可读 | 数据逐项 ACL、结构化状态投影、source/搜索/总数同样验权 |
| hooks 与临时 CLI 配置不兼容 | CC/Codex 的 HOME/config 隔离使 repo hooks 未加载 | 真正 runner 先行验证；发布版本兼容表；失败能看到 recording error |
| 用户 hooks 被破坏 | worktree 共享 Git common-dir、hook manager 重装 | opt-in 范围准确；配置前后差异和关闭恢复测试；不强制覆盖 |
| 自定义 refs 不被某 forge/API 返回 | REST 列 refs 和 Git transport 覆盖不同 | 以实际 ref OID 验证；使用授权机器读取，legacy backend 兼容；unsupported 明示 |
| 导入重放或旧来源被改写 | retry、force-push、同 checkpoint 多次 finalize | binding+checkpoint+metadata SHA 去重；ref manifest 对账；来源版本留痕 |
| 中途刷新导致画错线 | 两页之间新决定或候选状态变化 | snapshot fingerprint、409、laneState；不永久存图规避一致性问题 |
| 两数据库权限竞态 | 项目移动/成员撤销与应用库查询并行 | 前后版本核对、每次重新鉴权；不缓存长期权限或宣称跨库原子性 |
| 不完整历史被当作完整 | 无决定记录、没 push、Agent 无 code commit | coverage 和 null；元数据真实缺失在 issue 记录，不造来源 |
| Entire 升级破坏格式 | CLI/backend/hook协议变化 | 锁版本、parserVersion、两个格式的 fixtures；先测后升级，格式未知不吞内容 |

## 10. 本 RFC 已做的核查与尚未做的验证

**已做：** 完整读取 #1243～#1247、根 AGENTS.md 与 #1210 沙盒规则；阅读相关设计规则；在 Docker Cloud Sandbox 独立目录以固定 main revision 对照项目/工作区、MCP、run、Factory、迁移和 live 源码；核对 Entire 的官方发布/文档/命令帮助。

**Entire 配置实测（仅 disposable Git fixture）：** v0.12.2 包校验成功；无 Git 身份时 enable 非交互失败；补充 fixture 自己的 repo-local Git 身份后，CC enable、Codex agent add、status、disable、disabled status 均 exit 0；状态曾返回两种 Agent、`checkpoint_push_disabled=true`，关闭后 `enabled=false`。没有修改 Mikka 工作仓库的 hooks、用户真实仓库、官方模板或任何生产设置。

**尚未做：** #1245～#1247 的实现、迁移、真实模型调用、真实 Entire checkpoint/远端发布、地图 API 性能或生产验收。这些均受 Alex 的 RFC 评审门槛约束。这里的 JSON/拓扑 fixture 仅定义合同，不能当成生产数据或成功证据。

实现开始前再次检查相关源码差异和 Entire 固定版本是否仍符合批准方案；只因 main 有无关合并不强制 rebase。本次文档 PR 保持开放，等待 Alex 评审。
