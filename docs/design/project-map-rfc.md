# 项目地图后端 RFC

- **Status:** 2026-11-04 实施方案及原始交接计划；写入与读取接口已在仓库实现，现行合同见 [项目地图后端接口](project-map-api.md)。以下基线、步骤和示例保留实施时语境，不代表生产验收结果。
- **GitHub:** 父 issue [#1243](https://github.com/alexj11324/Mikka/issues/1243)；本 RFC [#1244](https://github.com/alexj11324/Mikka/issues/1244)；实施依次为 [#1245](https://github.com/alexj11324/Mikka/issues/1245)、[#1247](https://github.com/alexj11324/Mikka/issues/1247)。
- **Owner thread:** ChatGPT Pro，项目地图后端。
- **执行顺序:** #1244 文档 → #1245 决定写入 → #1247 地图读取；每步自行开 PR、合并、部署核对和验收，不等待中间评审。
- **前端边界:** [#1248](https://github.com/alexj11324/Mikka/issues/1248) 由另一个 Claude Code session 负责；本文规定接口、权限和状态，不实现页面、组件、Figma 或视觉样式。
- **源码基线:** `main@a2598ecb3a4b1ef128eb49f60a934d5f75bc5b52`（2026-11-04）；实施时复核相关接口的新变更。
- **设计来源:** #1243「方案」「前端要的形状」和 [2026-11-04-1726 决定](https://github.com/alexj11324/Mikka/blob/feat/project-map/docs/design/decisions/2026-11-04-1726-project-map.md)。`feat/project-map` 的代码仅为未评审 WIP，不作为数据模型依据。

## 1. 用户要完成什么

用户打开项目的「地图」，能看清在 Mikka 内走过的路线、为什么换方向、哪些路线停止，以及每一步对应的 Artifact、代码提交、PR、检查和原始对话。范围包括 bot 对话、Mikka 派出的 Claude Code / Codex 任务（本机 daemon、服务器、E2B）、审核验收、中途插话和提问回答。

**只使用 Mikka 自己的数据。用户在 Mikka 之外的工作不收集、不显示。任何情况下都不把 AI 对话写进用户代码仓库。**

原始对话与执行过程已经存在 Mikka 数据库；新增的业务事实只有「决定」及其结构化来源。后端把这些事实投影为地图，不另建一套任务状态机，也不把每次工具调用都画成节点。

### 1.1 设计原则

1. **事实持久化，图即时推导。** 新增决定事实和来源引用；不新增持久化的 `map_nodes`、`map_edges`、lane 或分支状态表。
2. **决定和记录者分开。** 「谁拍板」与「哪个 bot / Agent 记录」是两个字段；客户端不能自行声称自己代表 Owner 或另一位用户。
3. **依据不足就留空。** 重试、失败、候选更新、issue 父子关系均不自动等于方案分叉或放弃；推断必须另标 `inferred`，不能覆盖当场记录。
4. **权限逐项检查。** 项目可见不等于私有线程、聊天和凭证归属可见。新接口不扩大现有共享权限。
5. **收集和读取分离。** 地图 GET 只读数据库中的安全投影；不调用模型、不拉取用户代码仓库。
6. **同一版本内布局稳定。** 先对完整的可见事实做拓扑和 lane 分配，再筛选、折叠和分页；事实改变使游标明确失效，不混合两个版本。
7. **已有记录直接复用。** 本机、服务器和 E2B 任务均通过既有 Mikka run/chunk/message 上报链路提供事实；不安装新的编码采集器。

这里的「分支」是项目方案的路线，`gitBranch` 是 Git 分支名，`lane` 是一次布局中的显示列；三者不得混为同一个持久化字段。

## 2. 现有事实与接入位置

以下均为源码基线的现状；表名以现有代码为准，不在本项目中顺带重命名。

| 事实 | 现有来源 | 地图使用方式 |
| --- | --- | --- |
| 项目及任务列表 | `lib/db/project-schema.ts` 的 `workspace_projects`：`userId`、`issueIds`、`revision`；`app/actions/projects.ts` | 用项目 ID 和 task ID 关联，不能用可改名的项目名称作为外键；现有每项目 100 个 task 的限制不妨碍产生几百个地图节点 |
| 项目工作区和可见性 | `lib/project-access.ts`；`mikka_team_projects`、`mikka_workspace_members` | 共享项目从 team-project link 得到 workspace；无 team link 的项目属于 owner 的个人工作区；`properties.members` 不是权限授权 |
| 任务关系 | `issues`、`issue_attrs` / `readIssueMetadata`、`lib/issue-access.ts`、`lib/issue-visibility.ts` | 项目成员、parent、blockedBy、related、duplicate 分别保留其语义；dependency 边不冒充路线分叉 |
| 线程与执行 | `agent_runs`；`lib/run-chain.ts`；`retryOf`、`continuesRunId`、`threadReplacedBy`、`agentDefinition` | 每个 run 是一个执行事实；线程 root 按现有规则解析；冻结的执行身份优先于 bot 的当前设置 |
| 过程与插话 | `run_chunks(runId, seq)`、`run_messages`、`coordinator_messages`、`coordinator_sessions`、`group_turns` | 详情按来源权限读取；地图列表不携带完整 chunk 或提示词 |
| Factory 工作 | `factory_tasks`、`factory_attempts(taskId, position)`、`factory_candidates(taskId, id)`、`factory_events(taskId, eventId)` | 候选、执行阶段、检查和状态改变分别引用；review/verify 只关联到它实际检查的 candidate |
| Owner 验收 | `factory_deliverable_acceptances`、Factory 的已提交事件 | 只在有确实的验收事实时标记通过；不能用某个旧候选的验收证明新候选通过 |
| 问题和回答 | `lib/factory/questions/store.ts` 的 `factory_questions`（含 answerId/answerSource/answer/answeredAt）、`agent_runs.questionContinuation` | 回答与 questionId、originRunId、continuationRunId 显式关联；没有另造 answers 表；必要时成为决定证据 |
| Artifact 与代码发布 | `artifacts`、`artifact_versions`、`run_publications`、候选 SHA、任务 PR 元数据 | 指向精确版本和候选；PR URL 或最新 Artifact 不能替代当时的版本 |
| MCP 调用 | `app/api/mcp/route.ts`、`lib/mcp/{auth,worker,tools,actions,artifacts}.ts` | 只给 Mikka bot 和已绑定 Mikka run 的 worker 注册决定工具，共用服务层；仅改 `tools.ts` 不会让所有入口获得新工具 |
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
- `project.issueIds` 是任务归属事实；`issue.metadata.project` 名称只用于兼容显示。名字相同不能关联，未关联的 Mikka 对话不能靠项目名称猜测归属。

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
| `idempotencyKey, payloadHash` | text，必填 | 幂等键由服务端加上 run/bot/session 调用身份命名空间；同 scope、同调用者重投返回同一条；同 key 不同 payload 为 409 |

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

`sourceRef` 是服务端生成的不透明 ID；对外链接从已经校验的定位器构建。历史删除后的来源返回 `unavailable`；当前读者无权限的来源不返回 ID、标题、摘要、计数或 URL，避免通过“打不开的节点”泄漏存在性。

### 3.4 迁移和历史项目

- #1244 **不增加 SQL、Drizzle schema、工具或生产配置**。
- #1245 创建决定与来源表；#1247 只新增被查询计划证明需要的索引。不新增仓库采集配置、编码历史索引或外部工作接入表。
- 遵循 `scripts/migrate.mjs`、`scripts/migration-steps.mjs`、`scripts/check-migrations.mjs` 及现有按库迁移清单；应用库默认 `MIKKA_DATABASE_URL`，工作区库 SQL 文件头使用 `-- target: DATABASE_URL`。普通文件整条事务执行；`CREATE INDEX CONCURRENTLY` 必须单独文件配 `-- migrate: no-transaction`，遵循已有 INVALID-index 恢复规则。迁移编号按 `docs/dev-workflow.md §5` 领取/协调，实施时不得硬占一个现在看起来空闲的时间戳。
- Drizzle 声明和 SQL 一起变更；以新增表/索引为主，兼容旧服务，实际部署经 `pnpm build` 的既有迁移流程。验证空库、已迁移库再执行、旧数据及并发重投；失败用修复 PR，不能手改生产 schema。
- 历史项目从现有 issue/run/Factory/Artifact 事实开始显示；`decision: null`、`reason: null` 表示无记录，不能自动编造“选择了 X 因为 Y”。
- 允许后续按需进行有来源的事后总结；记录为 `inferred` 并保存 inference source/version。打开地图不触发付费推断，也不批量回填整个历史库。
- 没有决定记录的历史项目依然显示现有 Mikka 任务、执行、候选与产出；没有来源时保留 null/unknown，不能补造对话或执行。

## 4. 谁写入、何时写入

### 4.1 一个服务层，三种入口

计划新增 `lib/project-map/decisions.ts`，供 MCP、bot 工具及 HTTP 路由共用。对外工具注册名为 `record_decision`；在 Mikka 工具命名空间中显示为 `mikka.record_decision`。

| 入口 | 可信身份 | 写入范围 |
| --- | --- | --- |
| Mikka bot（含 Coordinator） | host 构造的执行上下文、botId、真实 user/workspace | 当前项目/任务及它有权引用的消息；模型不能传另一个 ownerId 来切换身份 |
| Mikka 派出的 CC/Codex | `verifyRunToken` → `workerRun` + 冻结执行身份 | token 对应的 run、issue、Factory task 和项目；每次写复核租约、停止、撤销与当前成员资格 |
| 人的「记为决定」 | 正常登录 session / 已有合法作用域的 API 身份 | 服务端读取用户选择的原消息/批准事件，并验证其可见性；不接受客户端拷贝的一句话冒充原文 |

已有个人 Coordinator 工具仍保持个人 workspace 行为。worker token 不能扩张到兄弟任务或另一个项目。通用 OAuth MCP 不提供无 Mikka 执行上下文的当场记录入口；人工标记仅引用已存在且可见的 Mikka 消息，不导入外部终端内容。

Bot 的 AI SDK/原生订阅工具和 `app/api/mcp/route.ts` 的 worker handler 必须都注册；并纳入现有 Agent definition/tool catalog 与系统提示生成检查。补充 `lib/run-app-mcp.ts`、`lib/run-prompt.ts`、`workflows/coordinator/tools.ts` 的冻结工具目录，以及 daemon 的 `packages/daemon/src/agents/mikka-mcp.mjs` stdio 注册/launcher 注入。现有 verify_command 只在 stdio 的 factoryVerify 配置存在时提供；不能把它或任意日志当成 record_decision 已可用的证明。#1245 以各真实调用入口的 tools/list 与实际调用验证接线。

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
- host 的工具 call ID/消息操作 ID 作为幂等键；人工 HTTP 客户端提供稳定键。mask/规范化后计算 payloadHash，同键不同内容为 `IDEMPOTENCY_CONFLICT`。
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


## 5. 地图读取合同（#1247）

### 5.1 端点与共同约定

所有地址含现有 base path `/mikka`。服务端文件在 `app/api/projects/[projectId]/map/...`，浏览器通过既有 base-path helper 访问。返回 `schemaVersion: 1`，时间为 UTC ISO 8601，ID 为稳定不透明字符串。

| 方法与路径 | 用途 | 主要参数 |
| --- | --- | --- |
| `GET /mikka/api/projects/:projectId/map` | 首屏/连续分页/展开一个折叠分支 | `workspaceId` 必填；`limit=50`（1～100）、`cursor`、`laneLimit=3`（只能 2 或 3）、`branchId?`、`q?`、`filter=all\|mainline\|abandoned\|with_artifacts`、`from?`、`to?` |
| `GET /mikka/api/projects/:projectId/map/nodes/:nodeId` | 按需详情，包含六个固定 section | `workspaceId`、`snapshot` |
| `GET /mikka/api/projects/:projectId/map/path` | 从项目起点到选中节点的完整路径 | `workspaceId`、`nodeId`、`snapshot`；不受当前筛选隐藏的节点影响 |
| `GET /mikka/api/projects/:projectId/map/overview` | 全图 minimap、可见分支与时间密度 | `workspaceId`、`snapshot`、与列表相同的过滤条件 |
| `GET /mikka/api/projects/:projectId/map/sources/:sourceRef` | 原始来源定位和允许读取的安全片段 | `workspaceId`、有界分页；重新校验来源权限，不作为任意 URL 代理 |

GET 共享项目/来源鉴权。详情和 path 不把“nodeId 存在”当作有权限。请求只能访问一个 workspace/project，API 没有 `ownerId` 切换参数。不返回完整提示、订阅邮箱、模型凭证、服务器绝对路径、带 token 的 URL。

### 5.2 摘要 DTO

以下 TypeScript 是合同说明，不是本 PR 的实现代码：

```ts
type MapNode = {
  id: string; // project:<id> | issue:<id> | run:<id> | candidate:<id> |
              // decision:<id> | end:<branchId>
  type: "project" | "task" | "run" | "candidate" | "decision" | "branch_end";
  title: string;
  result: string | null;
  status: "planned" | "active" | "waiting" | "completed" | "failed" | "abandoned" | "unknown";
  occurredAt: string;
  order: number; // 本 snapshot 的全图拓扑序，不因分页/筛选重编号
  branchId: string;
  lane: number | null; // 当前 laneLimit 下 0..limit-1；null 表示折叠
  detailAvailable: boolean;
  badges: { artifacts: number; pullRequests: number; checks: number };
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

### 5.3 从事实构图，不把顺序当因果

1. 用已经通过权限检查的 project→issue 集合作为范围；批量读取运行摘要、Factory 版本/事件、决定。历史数据无记录时明确 unknown。
2. 优先采用明确决定的 `contextOptionRef`、predecessor、branch-work/merge 引用构造路线。按有效的追加决定投影 option 的当前状态：后来的 abandon/merge 引用原 contextOptionRef 改变路线结论，原 choose.options 保持当时内容；supersedes/retracted 按修正链处理，不能原地改写过去。任务的 parent/blockedBy 仍为组织/依赖关系，不自动选择其中一个任务作为被放弃的方案。
3. `retryOf/continuesRunId` 和同候选 review/verify 表达执行延续；`threadReplacedBy` 表达被替换事实。只有相关决定/已验证终止事件能把路线标成 abandoned。旧 candidate 不是当前 candidate，不等于已放弃。
4. 已获采用的 candidate 只在对应的 acceptance/merge 证据存在时接回已选路线；未采用但成功产出仍保留。Git commit 的两个 parent 是 Git 合并事实，若不能映射到项目路线，就只显示在代码详情，不虚构项目合流。
5. 每个没有明确前驱的独立工作挂在项目根节点下，保持 unknown lineage；时间只排序，不推断“上一条就是原因”。
6. `contextOptionRef` 继承沿 `continuesRunId/retryOf` 到后续 run；同一时间多个相关决定冲突时返回 unknown 分配并在详情列出证据，不能按最近时间随意选。任意手动引用都需验证同 scope。
7. 先做稳定拓扑排序：前驱优先；同时可排序的节点按可信 occurredAt、source 类型、稳定 ID 排序。未来时间/时钟偏差单列来源时间，不把图排成回边。依赖循环不拖垮地图；它不加入路线 DAG，并返回可诊断的 coverage 问题。
8. 全图只有一套稳定语义 ID。节点标题、状态和具体 lane 可随新 snapshot 更新，ID 不随分页、宽度、候选状态或来源修正变化。

### 5.4 lane、折叠、放弃和跨页连接

- lane 0 保留为主线。**每个 option 都有独立的 `option:<decisionId>:<optionId>` 语义 branchId**；selected option 只继承父路线当前 lane，由 continues 边连接，不能复用父 branchId。mainlineBranchIds 是明确选择构成的历史路线链/集合。后续 abandon(context=D1.A)、redirect 选择 C 分别作用于 A、C，能够同时返回 A 已放弃而 C 活跃，项目根和共用历史不被一并改成 abandoned。其余 option 依稳定 option ID 顺序，分配**父 lane 右侧最小的空闲 lane**。
- laneState 记录当前可见的末端路线占用；selected 子路线接管父路线的同一 lane，是路径延续而非并行占用。并行 active 路线之间不复用 lane；只有明确完成、合流或放弃后的行之后才能把 lane 释放给另一条并行路线。失败但仍等待处理的 run 不释放整条路线。
- 显示预算由 `laneLimit` 指定：桌面 3、手机 2。没有右侧空 lane 的路线作为 fold 返回，不能挤进父 lane、删掉或按页截断。
- 超预算的路线在该 snapshot 中整条折叠，不在后面的某页突然冒到另一条 lane。fold 的 ID 由父路线、被折叠路线集合和 layoutVersion 决定，anchor 位于可见父路线内；多条隐藏路线的聚合 fold 列出 branchIds，用户选择其中一条再用 expand 请求。带 `branchId` 请求独立子图时选中路线成为局部 lane 0，返回 focus.breadcrumbs 供定位原分叉。语义节点 ID 不变。
- 放弃路线返回真实 `stoppedAtNodeId` 和理由来源；若只有“未采用”，终止点是决定节点；无法知道停在哪则 null，不猜最后一个失败 run。
- 首屏之后的分页返回 `laneState.before/after` 和 `boundaryNodes`，使分页两侧的连线不断开。边的另一个端点必须位于 nodes 或 boundaryNodes；非授权端点绝不作为 boundary 返回。
- 选择节点时 path 接口返回路线祖先节点/边 ID、选中的 option、合流的多条祖先链以及折叠分支展开定位。dependency 边不算历史路径。
- 多个前驱合流时不存在唯一一条历史路径；接口返回所有有证据的祖先路线，同时标出 `primaryPathNodeIds` 作为主线高亮顺序。前端不必自行猜哪条边是真正选择。

### 5.5 筛选、搜索和分页一致性

`q` 最多 200 字符，只搜索已获授权的标题、结果、决定理由、Artifact 名称和安全文件路径，不搜索原始 transcript、private prompt 或凭证。首版对几百/一千个投影节点做内存规范化子串匹配，覆盖中英文；不引入外部搜索服务或 pg_trgm 扩展。

`mainline` 取 mainlineBranchIds 指定的已选路线链/集合及其共同前驱；`abandoned` 取明确放弃/未采用的路线及其分叉定位；`with_artifacts` 只计实际可见的 Artifact。筛选后的 nodes 只包含命中项，但保留其原始 order/lane，并以 boundary/fold 定位到全图。筛选不重新分配 lanes，也不会让路径接口丢掉被筛掉的祖先。互斥 filter 用单一枚举，避免前端组合出含义不明确的条件。

**游标方案：**

- 首次查询读取轻量源事实集合并计算 fingerprint：project revision、授权后实际影响节点/边的 source ID、状态、结果和来源版本摘要、Factory revision、决定集合摘要、权限作用域版本。不把 heartbeat、token 续期和每个 stream chunk 的更新时间算成地图版本；active run 的 result 在没有稳定结果时为 null。不能只用一个 max(timestamp)，因为删除、中途插入和旧记录修改都会漏掉。
- 使用签名的不透明游标包含 `viewerId, workspaceId, projectId, fingerprint, filtersHash, laneLimit, layoutVersion, lastOrder, lastNodeId, expiresAt`，有效 10 分钟。签名由服务端现有 secret 使用 `project-map-cursor:v1` 域隔离派生；不把 secret 放进 token。
- 下一页重新构造同 scope 的轻量投影；fingerprint 或筛选/宽度不一致，返回 **409 `MAP_SNAPSHOT_CHANGED`** 和 `restart: true`。前端保留旧画面再取首屏，不把旧页和新页拼接。
- 失效 token 为 410 `MAP_SNAPSHOT_EXPIRED`；签名/结构错误为 400；跨 reader/workspace/project 或已撤销权限为 404。鉴权先于内容和总数计算。
- 两个数据库不具备统一 MVCC snapshot。实现中的应用库元数据和来源权限由一条只读 SELECT 读取，无额外 BEGIN/COMMIT；工作区/项目权限在读取前后复核。现行读取边界见 [接口说明](project-map-api.md#分页来源与界限)。
- 服务端不持久化图副本；snapshot.id 是不透明、签名且绑定调用主体/scope/查询的版本 token；detail/path/overview 每次以它复核相同 fingerprint，不是任意客户端可填的哈希。新决定到达或实际状态改变时，版本改变是预期行为。

### 5.6 详情、原始来源与 minimap

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

### 5.7 权限、性能和刷新

HTTP 适配复用现有 API 的 session/token 解析、日志与 `Cache-Control: private, no-store` 约定；完整保留 `[tokenWorkspace]` principal，禁止降成裸 `user.id` 后丢失 PAT 的 workspace 限制。nodeId/sourceRef 进入 URL 时需要编码。

**权限顺序：** 验证 session/token → 选定 workspace 且 active membership → 验证项目归属/共享资格 → task ACL → run/Factory/Artifact/原对话/仓库 ACL → 构图、搜索、计数。项目 owner 并不自动拥有其他成员私有 run 的完整内容，workspace admin 也没有这种越权读取路径。复用 `workspaceRunView` 的安全结构化状态投影；不得直接 select 原始 report/message JSON 回给团队成员。

所有详情、source、path、overview、分页以及决定写入都测试跨 owner、跨 workspace、被移除成员、被撤销仓库授权。cursor 缓存或 sourceRef 不是访问凭证；日志只记录 request ID、错误代码、耗时和数量。

**性能目标（待 #1247 实测，非本 RFC 的成绩）：**

| 情况 | 目标 |
| --- | --- |
| 500 个可见节点，第一页 50 条 | 同区热请求 p95 ≤ 500ms；生产端到端单列统计 |
| 1,000 个可见节点，分页/筛选/overview | 同区热请求 p95 ≤ 1s |
| 单节点详情，不含原始 transcript | p95 ≤ 500ms |
| 默认列表响应 | gzip 后 ≤ 150 KiB；不得带全文 transcript |
| 查询量 | 固定批量查询，初版目标 ≤ 12 次数据库往返；不随节点数产生 N+1 |

先在权限范围内只取摘要列，Artifact/PR/check 聚合批量取，整个轻量图只在内存里短暂存在；原始对话分段按需读取，每次最多 100 条或 256 KiB，超出返回 continuation，不能静默截断成“完整”。

新增 `project_map` 失效 kind，沿用 `lib/live/events.ts` 的 `{kind,id}` 协议及既有 scoped channel。决定提交、project/issue 关系改变和影响地图的 Factory/run/Artifact 状态提交后合并发送失效通知；回滚不推送。需同步 server 与 gateway 的 allowlist/合同，不能只在应用侧新增枚举。共享内容通知只发给已有权限对应的 channel，不携带节点标题和对话。

通知丢失沿用已建 live 通道的断线/重新连接对账策略；地图不新增高频轮询、不注册一个每节点定时器。GET 的内容版本与 ETag 承担最终一致性，不能只靠一次推送保证永远最新。


## 6. 前端对照与示例

### 6.1 父 issue 每条要求的落点

| #1243「前端要的形状」 | 后端合同 |
| --- | --- |
| 项目地图标签页 | 按 projectId/workspaceId 读取，无新全局入口；#1248 负责 UI |
| 竖向主线和分叉 | stable node ID、全局 order、continues/fork/merge 边、branchId、lane |
| 嵌套分叉、选中方案留原道、结束后复用 | §5.4 确定性分配；明确 contextOptionRef，lane 只在有终止证据后释放 |
| 桌面 3 道、手机 2 道、深分支折叠 | laneLimit 2/3、folds 和 branchId 子图请求 |
| 放弃路线保留、停在哪、为什么 | branch status、stoppedAtNodeId、reason、sourceRefs；样式由前端处理 |
| 选节点高亮从起点到它的路径 | path 返回 primaryPathNodeIds 及全部路线祖先，跨分页/折叠 |
| 右侧/手机抽屉详情的六个区域 | 固定 tasks → decisions → artifacts → checks → conversation_summary → threads |
| 缩略图 | overview 有界 bins、laneSegments/folds/branchLinks 完整布局骨架、相同 snapshot/laneLimit/focus |
| 搜索、只看主线/放弃/有产出 | q 与 filter、scope 内搜索计数；过滤不重排 lane |
| 理由、当场/推断区分、原始来源链接 | decision.provenance、reason、validated sourceRefs；人工标记保留独立入口来源 |
| 产出、PR、检查、执行、原始对话 | 列表 badges + 详情 references + 精确 candidate/version/source IDs |
| 几百节点分段取与筛选 | 有界 limit、签名 cursor、boundaryNodes/laneState、409 刷新语义 |

### 6.2 示例响应

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
    "decisions": "recorded"
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
        "checks": 0
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
        "checks": 0
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
| 7 | Bot 在 Mikka 内明确关联本项目的对话决定 | 通过原始消息定位查看 | 相同语义 ID |

另测 D1 选 A → A 明确放弃 → D2 redirect 选 C：A/C 语义 branchId 不同但可沿同一 lane，A 的停止理由和 C 的 active 状态同时保留，不污染项目根。每个分页位置都切一遍，验证相邻页边界、lane 释放和路径一致；不把这一 fixture 当作生产真实任务。

## 7. 分步上线、验收和交接

### 7.1 #1244：文档修订与合并

本 PR 只修改本文和对应的产品决定记录。逐条对照 #1243/#1244/#1245/#1247、检查源码关联、校验 JSON 示例和文档 diff；CI 按当前 `scripts/ci-docs-only.mjs` 运行文档门禁，重型 unit/database suite 按仓库规则跳过。

按最新明确授权，由负责人确认最新 head 的适用检查全绿及可合并后自行 squash 合并，再回 #1244 记录 PR/merge commit/剩余步骤。合并后仍按本任务要求跟踪 Web deploy、核对生产 `/mikka/api/version.build` 与合并 SHA。若 docs-only 被既有 workflow 跳过导致二者不相等，明确报告此项尚未满足，检查既有受支持的部署入口；不能用旧 build 冒充通过，也不擅自改 CI/deploy 规则。后续实现 PR 同样要求精确版本核对。

### 7.2 #1245：决定写入

1. 新表/迁移、共用写入服务、worker MCP/bot 工具、人工接口、提示和漏记检查同一个可评审后端 PR。
2. 在 Docker Cloud Sandbox 的独立数据库和正常 TestAccountPool 会话验证：bot 与 Mikka 派出任务的工具入口、手动原消息定位、字段上限、幂等重投/冲突、并发修正、来源不存在、跨 run/owner/workspace、成员撤销、停止/过期 token、masking。
3. 真实本地 API/CLI flow：bot 讨论选方案，派 CC/Codex 做任务，中途一次明确改向，工具实际写入并可由 owner 读取；相同会话的工具 trace、决定行、origin source 定位一致。
4. 最新 head 适用 CI 全绿后 squash；跟踪 GitHub Actions Web deploy 完成，生产 `/mikka/api/version.build` 精确等于合并提交，再开始此版真实生产验收。
5. 生产两个订阅各做一项真实工作，记录 host 订阅 claim、run ID、实际模型、工具 call、decision ID、改向原消息、来源和时间；bot 另记一次决定。运行路径矩阵见 §7.4。

### 7.3 #1247：读取与前端交接

1. 基于 #1245 与现有 Mikka 工作流在生产产生的数据实现 graph projection、各读取接口、共享 schema、失效通知及索引；不复用 WIP 中未验权的 join。
2. 单元/数据库/API 测试覆盖：明确分叉、嵌套、abandoned/not_taken、真实 merge、无原因历史、原始对话、源删除、幂等重投；两个 laneLimit、所有筛选、page boundary、path/minimap、scope 撤销、snapshot 变化。
3. 生产 owner 真实项目必须有分叉、放弃原因、当场决定、Artifact、同候选检查和原始对话；逐项对照 Mikka 数据库与原始消息，不能只用写死 JSON 演示。
4. 500/1,000 节点的性能项目在隔离环境可用可重复 fixture；生产另测已有几百节点的授权项目，记录实际数量、region/冷暖状态、请求次数、p50/p95、响应体大小。若尚无这样规模的生产项目，只能标此项未完成，不批量污染生产数据伪造指标。
5. 生产 API 版本验证后，在 #1247 评论写清：接口路径、请求/响应、**真实项目脱敏 JSON**、cursor/409、lane/fold/path、权限/已知限制、验证 revision 和证据。然后在 #1243 写「**后端已完成，可以开始前端**」。
6. 前端交接前没有通过的限制必须写明；不能将 RFC、WIP 或单元测试结果称为后端已上线。

### 7.4 两条订阅路径独立记录

按 `AGENTS.md` 的最新验收规则执行。两条路径各用自己的订阅和小模型。

| 路径 | 固定模型 | 必须记录的真实证据 | 外部阻塞时 |
| --- | --- | --- | --- |
| Claude Code 官方订阅 | `claude-haiku-5-5` | 原生订阅 claim、原始 run/session、工具调用、来源对话 | 记录实际错误和 BLOCKED，继续 Codex 路径 |
| Codex 官方订阅 | `gpt-6-luna` | 原生订阅 claim、原始 run/session、工具调用、来源对话 | 记录实际错误和 BLOCKED，继续 Claude Code 路径 |

API-key/DeepSeek 不作为合并或验收门禁，不为补齐矩阵发送付费 API 请求。
已有用例保留原绑定的订阅与模型。内部 Decision 裁判沿用现有 `DECISION_MODEL`。
每条订阅分别记录 PASS / FAIL / BLOCKED。产品缺陷修复后重跑，外部额度或服务故障记录真实阻塞。

每个子 issue 记录 PR、merge SHA、适用 CI、部署 run、生产版本、核对时间、两条路径的结果与证据及剩余事项。
生产身份使用 `AGENTS.md` 指定的共享验收账号及其已授权团队工作区。

## 8. 实施风险

| 风险 | 现实触发路径 | 处理 / 验证 |
| --- | --- | --- |
| 把失败当作放弃 | 模型 429、基础设施重试、旧候选被替换 | 使用明确语义事实；对应反例进入 graph 测试 |
| 漏记、错误归因 | 人临时拍板、模型未调用工具 | provenance、source linkage、review warning；不事后伪造当场记录 |
| 私有内容通过共享项目泄漏 | 项目可读而私有 run/chat 不可读 | 数据逐项 ACL、结构化状态投影、source/搜索/总数同样验权 |
| 中途刷新导致画错线 | 两页之间新决定或候选状态变化 | snapshot fingerprint、409、laneState；不永久存图规避一致性问题 |
| 两数据库权限竞态 | 项目移动/成员撤销与应用库查询并行 | 前后版本核对、每次重新鉴权；不缓存长期权限或宣称跨库原子性 |
| 不完整历史被当作完整 | 无决定记录、旧消息已删除、执行未完成 | coverage 和 null；元数据真实缺失在 issue 记录，不造来源 |

## 9. 验证记录与实施约束

本次修订依据 Alex 的最新明确指令、#1243 最新正文及 PR #1253 的范围变更评论。文档先合并，随后按 #1245 → #1247 连续实施；不设置中间人工评审关卡。

文档核查包括范围排除、JSON 示例解析、字段/来源一致性、父 issue 逐项对照和文档 CI。文档通过不代表决定工具、地图 API 或真实生产验收通过。每个实施 PR 以其最新提交、实际数据库/API/CLI 和生产记录为证据。

地图只读取 Mikka 内部数据。采集、存储、日志和发布链路均不得把 AI 对话、工具输入输出或原始消息写入用户的代码仓库；不存在外部 CLI 历史扫描、Git hooks 注入或自动收集 Mikka 外部工作的入口。
