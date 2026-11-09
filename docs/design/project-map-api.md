# 项目地图后端接口

实现依据：[项目地图 RFC](project-map-rfc.md)。本文件描述已实现的接口；地图读取接口由 #1247 补充。

## 范围与认证

数据来自 Mikka 已有的对话、派发执行、人工插话、问题回答、审核和产出。后端不采集 Mikka 之外的工作，也不把对话、决定或工具调用轨迹写入用户的代码仓库。

路径均带应用前缀 `/mikka`。HTTP 使用正常登录 session 或现有 workspace-scoped PAT；浏览器 POST 需要同源 `Origin`。每次请求重新验证 active membership、项目的 workspace 归属和任务权限。浏览器请求也被限制在显式传入的 workspace，不能利用同一账号在别处的权限串入数据。响应统一 `Cache-Control: private, no-store`。

决定内容保持 writer 的 owner 边界。项目后来共享、移动或改名不会把原有私有对话和决定理由自动共享给别人。来源读取需要再次通过原记录权限；不可见来源不返回定位器、标题或原文。

## 人工记录与补标

### POST /mikka/api/projects/:projectId/decisions

请求包括：

| 字段 | 约束 |
| --- | --- |
| `workspaceId` | 必填 UUID；必须与当前项目和 PAT scope 一致 |
| `kind` | `choose / redirect / abandon / merge / confirm` |
| `title / summary / reason` | 非空，分别最多 200 / 500 / 4000 字符 |
| `options` | 最多 20 个；每项稳定 `id`、`title`、`disposition`，以及可空的 `reason / derivedFrom / stoppedAtSourceRef` |
| `selectedOptionId` | choose/redirect 必须指向唯一 selected option |
| `contextOptionRef` | 可选 `{decisionId, optionId}`；abandon 必须提供 |
| `predecessorDecisionIds` | 同 owner/project/workspace 中已存在的决定；merge 至少两项 |
| `issueId / factoryTaskId / runId` | 可选；提供时必须存在且彼此匹配 |
| `sources` | 最多 50 个 `{role, optionId?, source}`；角色为 evidence、branch_work、stopped_at、merges_from |
| `decidedBy` | 可选 `{kind, id?}`；输入不能冒充另一个主体。bot/worker 声称人拍板时必须提供那个人的真实来源；省略 id 时只能从唯一已验证的 human 作者解析 |
| `supersedesId / recordStatus` | 修正、撤销均追加新记录；retracted 需要 supersedesId |
| `provenance` | 默认 recorded；inferred 必须有来源，并记录 reconstructed，不冒充当场决定 |
| `idempotencyKey` | 必填，1–200 字符；同操作重试保持不变 |

rejected/abandoned option 必须说明理由。当前记录中路线停止的位置用 role=stopped_at 的来源表达；`stoppedAtSourceRef` 如提供，必须是当前可访问的已存在来源 UUID。

不接受 `ownerId / recordedBy / recordedAt / hostVerified` 等身份或审计字段。服务端解析身份、来源、事件时间与 captureMode，脱敏后计算 payload hash。相同 key、相同内容返回原 ID；相同 key 改变内容返回 409。并发修正同一旧决定只有一次成功，旧理由和旧来源保留。

新记录返回 201：

```json
{
  "decisionId": "00000000-0000-4000-8000-000000000001",
  "duplicate": false,
  "recordedAt": "2026-11-04T00:00:00.000Z",
  "projectId": "00000000-0000-4000-8000-000000000002",
  "workspaceId": "00000000-0000-4000-8000-000000000003"
}
```

示例 ID 和时间是文档占位值。相同操作重试返回 200、duplicate=true。

### POST /mikka/api/projects/:projectId/decisions/from-message

使用同一请求结构，额外传 `source`。服务端读取原记录，不接受一段客户端拷贝的文字冒充原消息。支持 bot_message、group_message、run_message、question、answer、acceptance。

常用定位器：

| type | id 与其他定位字段 |
| --- | --- |
| bot_message | id=coordinator_messages UUID；可附 botId、position；旧 null-bot Coordinator 只允许本人个人 workspace |
| group_message | id=conversation_messages UUID；可附 conversationId、position；当前人和 bot 的群成员资格分别检查 |
| run_message | id=run_messages UUID；可附 runId；无 runId 仅接受具备双向 run/mailbox 绑定的内部消息 |
| question | id=question UUID；可附 taskId、runId、revision（originRevision） |
| answer | id=question UUID，必填 answerId；必须匹配真实回答身份 |
| acceptance | id=deliverable acceptance UUID；必须匹配同 task/candidate/run |

所有可选坐标只会收窄校验，不能赋予权限。没有稳定任务/run 关联的 bot、Coordinator 或 group mailbox 不作为项目来源；这些聊天仍可用 bot_message/group_message 显式关联，关系标记为 declared。

人工补标使用 captureMode=human_marked。接口不修改原消息，不启动任务，也不调用模型。

### GET /mikka/api/projects/:projectId/decisions?workspaceId=:workspaceId

返回 `{projectId, workspaceId, decisions}`，最近 100 条当前可读的决定，用于决定管理和验收。每条含 `id / kind / title / summary / reason / options / selectedOptionId / contextOptionRef / predecessorDecisionIds / provenance / captureMode / decidedBy / recordedBy / occurredAt / recordedAt / supersedesId / recordStatus / sources`，以及关联 scope IDs。

`recordedBy` 包括 kind、id、userId、botId、runId、modelId、harness、identityAssurance。没有冻结的模型事实时 modelId=null；不会用当前设置补造历史执行身份。响应不含内部 idempotencyKey 或 payloadHash。

来源摘要为 `{sourceRef, role, optionId, relation, availability, locator}`；不带原对话。读取时重验来源 ACL。只有主机保存的 issue 锚点当前仍可读、且已证实原 run 删除时，执行来源才可返回 availability=unavailable、locator=null；权限无法确认时隐藏相应决定，不把“来源不存在”和“已撤权”混为一谈。

地图全量查询、筛选、分页和原始来源详情使用 #1247 的专用读取合同，不将此 100 条列表当作完整地图。

## Bot 和 worker

- 注册名是 `record_decision`；Mikka worker 的 MCP server 通常表现为 `mikka.record_decision`。
- hosted/native bot 复用同一 writer，从 host execution scope 取 owner/workspace/bot，不能从模型参数切换身份。冻结为只读或已撤权的执行不获得新写权限。
- worker 使用其真实 run token；每次写入重验 run/issue/Factory 绑定、停止、租约、撤销、执行身份及当前成员资格。只有一个真实项目包含该任务时可省略 projectId。
- daemon stdio 将工具调用直接发给 Mikka HTTP MCP；不使用仓库 handoff 文件存放决定或对话。
- 选择有实质取舍的方案、改向、放弃已走的路线、合流、人在场拍板时记录；普通命令、格式化、重试或模型恢复不记录为决定。
- 工具成功结果与 HTTP 一致。没有持久化成功结果就不能声称已记录。

## 错误

| HTTP | 含义 / 常见 code |
| --- | --- |
| 400 | 字段、选项或来源格式不合法；INVALID_DECISION、UNKNOWN_OPTION、DECIDER_REQUIRES_EVIDENCE |
| 401 | 未登录或 run token 无效 |
| 403 | 浏览器缺少同源 Origin，或执行上下文已失效 |
| 404 | 项目或来源不存在，或当前身份不可见；不暴露跨账号对象是否存在 |
| 409 | IDEMPOTENCY_CONFLICT、DECISION_VERSION_CONFLICT、SCOPE_MISMATCH、PROJECT_SCOPE_CONFLICT |
| 413 | HTTP 请求超过 64 KiB |
| 503 | 暂时无法读取依赖或持久化；保持原 idempotencyKey 重试 |

## 验证与生产验收

本地检查由 source/type/lint、真实隔离 PostgreSQL、真实 HTTP PAT 与 worker MCP 调用，以及 daemon stdio 协议测试组成。源 SQL 用当前迁移后的真实 schema 校验。

生产验收使用 `AGENTS.md` 指定的共享验收账号，在其已授权的团队工作区使用有效订阅绑定。凭证不得进入日志、截图或 GitHub。按最新 AGENTS.md，仅记录 Claude Code 订阅 claude-haiku-5-5、Codex 订阅 gpt-6-luna 两条路径；DeepSeek 不再是合并和验收门禁。订阅需先证明原 thread 仍工作，再真实插话改变方向，核对工具记录、实际执行身份和产物；只列出模型、只读工具目录或结束后续跑不算这项通过。生产操作遵循对应 issue 已有授权和 `AGENTS.md` 的验收范围。

完成记录以对应 issue 的 PR、commit、Web deploy、生产 version 和脱敏验收报告为准。

## 项目地图读取（#1247）

实现与共享类型位于 `lib/project-map/read-contracts.ts`、`response-contracts.ts`；构图使用 `graph.ts`。这里列的是后端合同，不代表前端或生产真实任务验收已经完成。所有读取只使用 Mikka 已有事实，不调用模型、不读取用户代码仓库。

| GET（统一前缀 `/mikka/api/projects/:projectId/map`） | 参数与返回 |
| --- | --- |
| 根路径 | `workspaceId` 必填，`limit=50`（1–100）、`laneLimit=3`（2/3）、`cursor?`、`branchId?`、`q?`、`filter=all/mainline/abandoned/with_artifacts`、`from?/to?`；返回 nodes/edges/branches/folds、跨页 boundaryNodes/laneState、coverage、snapshot、page |
| `/nodes/:nodeId` | `workspaceId, snapshot`；固定 tasks、decisions、artifacts、checks、conversation_summary、threads 六个 section。project/task 节点关联自己的可读工作；run/candidate 只关联有实际关系的工作 |
| `/path` | `workspaceId, nodeId, snapshot`；全部明确因果祖先、实际边、可确定的 primaryPath、选中路线及展开位置 |
| `/overview` | `workspaceId, snapshot`；过滤条件必须与 snapshot 一致；最多 100 个 bin 和完整有界布局骨架 |
| `/sources/:sourceRef` | `workspaceId, limit=50, cursor?`；单来源按需读取。仅接受 `run:<uuid>` 或 `source:<已持久化来源uuid>`，不接任意 URL |

nodeId/sourceRef 必须 URL 编码。`schemaVersion=1`。成功响应包含 `live: {ownerId, workspaceId, revisions}`，以及强 ETag（本次原始 JSON 的 SHA-256）和 `Cache-Control: private, no-store`。ETag 是表示版本；当前不返回 304，带 If-None-Match 的请求仍完整验权。首屏新签发 snapshot 的到期时间会改变响应字节，不能用“首次请求的 ETag 永久不变”代替内容/权限检查。

### 决定、路线与证据

只用 contextOptionRef、predecessorDecisionIds、branch_work/stopped_at/merges_from、run retry/continue/replacement、候选与检查关联构图。时间只决定稳定排序，不把相邻工作推断成因果。明确放弃和未选路线保留终点/原因；失败的 run 不自动变成放弃。候选只有自己的 deliverable acceptance 或已合并的 factory_merges 回执才能完成；单有 PR URL、review passed 不算合并。

决定详情明确投影可见语义与 sourceRefs，不透传 sources 原行、recordedBy/decidedBy 内部对象、idempotencyKey 或 payloadHash。历史更正/撤回保留在可见详情；被替代的事实不继续参与当前路线。Artifact 链接指向当时的精确 versionId/数字版本，检查指向精确 candidateId。私有 section 对没有来源权限的成员为空，不返回私有条目数量。

### 分页、来源与界限

snapshot/cursor 以服务端密钥签名，绑定 viewer、workspace、project、过滤/布局和内容 fingerprint，10 分钟过期。有效期内仍逐次检查当前权限。内容或查询变化返回 `409 map_snapshot_changed`（`restart:true`），过期返回 `410 map_snapshot_expired`；不能拿别人的 cursor 切换主体或项目。

原始来源使用 `sourceKind` 区分：

- `run_chunks`：本次 run 的 chunk 流；不是全部初始提示或人工消息。人工消息有自己的持久化 sourceRef。每页最多 100 条、原始响应最多 256 KiB；DB 正文预算 200 KiB，先在 SQL 内计字节再传正文。首屏固定 seq 上限；后续追加不挤入这组页，删除原 chunk 则返回 409。
- `record`：单个原始来源先做 SQL 大小检查，原记录最多 64 KiB；脱敏后每段最多 16 KiB，超出给 continuation，内容变化返回 409。单条过大明确返回 413，不把截断预览冒充完整来源。
- `unavailable`：只用于曾验证的 run 来源已删除，且当前仍能验证其可读 issue anchor；locator 为 null、items 为空。权限撤销返回 404，不用 unavailable 暴露私有对象。

source 查询只重核本次决定的最多 50 个 sourceRef 及最多 51 个 run ID，整个引用投影在 SQL 内限制为 64 KiB；不为每段来源重读整图。即使所请求的单条来源仍可见，同一决定的另一条来源失去权限，也不能利用保存的 sourceRef 继续读取该决定来源。

地图元数据有独立预算：每项目最多 100 个 issue ID（SQL 投影同时限制 4 KiB）、2000 个节点、2000 条路线、20000 条边、10000 个来源引用，整次 app DB 元数据投影合计最多 1 MiB。超限明确返回 413；项目关联异常返回 409。**256 KiB 是原始来源响应硬界限，不是地图列表原始 JSON 的硬界限。** 列表目标是默认页 gzip ≤150 KiB；根节点连接大量独立运行时，跨页边和边界节点会使首屏 raw JSON 大于 256 KiB，仍不包含 transcript。

应用库的完整地图 facts 与来源授权在一条纯只读 SELECT 中读取，使用该语句的一致快照，无额外 BEGIN/COMMIT。项目/工作区权限仍在读取前后分别重查两个 authority DB，脱敏材料也每次重新读取；它不是跨两库的统一 MVCC 快照。workspace PAT 的成员资格被停用后，认证层使 PAT 失效并返回 401；已认证但不可见的项目/来源返回 404。

### 实时刷新与错误

`project_map` 复用现有 scoped live channel。决定、project/issue 关系、影响地图的 run/Factory/Artifact 状态在提交后发内容为空的 key；回滚不推送，同一提交的重复注册合并。沿用 main 的 live_revisions：一次 fan-out 对每个项目只增加一次 revision，所有当前收件人收到同一个值；GET 先读取 revision 再读取内容。版本提升失败时保留既有普通失效 key 回退。没有新增定时器或轮询。

稳定读取错误包括 `map_invalid_request`（400）、`map_auth_required`（401）、`map_not_found`（404）、`map_scope_conflict/map_snapshot_changed`（409）、`map_snapshot_expired`（410）、`map_too_large/map_source_too_large`（413）、`map_unavailable`（503）。原因以 cause 链保留，仅记录安全类型/代码；文案在既有中英文 RunErrors registry 内按 code 一一映射。

### 隔离环境的读取量（2026-11-05）

Medium 4 CPU / 8 GiB、PostgreSQL 17，500/1000 个 run（另有 project/task 两节点），每路 10 次暖请求。表中 KB 按 1000 B 计；DB 是实际 app/workspace PG 结果行 JSON 字节，包含 PAT 认证、当前权限、revision 与内容读取，不是 PostgreSQL 协议字节或 Neon 账单。HTTP 是单次响应 raw JSON，gzip 单独列出。测试通过真实 socket 调用 handler，并走真实 PAT 验证；此性能测量不等同于正常 Next + 租用账号验收。

| GET | 500 runs：DB / HTTP / gzip KB | 1000 runs：DB / HTTP / gzip KB |
| --- | --- | --- |
| map 首屏（50条） | 157.540 / 176.705 / 27.454 | 313.040 / 338.708 / 53.200 |
| map 后一页 | 157.540 / 30.703 / 3.674 | 313.040 / 30.704 / 3.662 |
| map q=codex | 157.540 / 30.708 / 3.677 | 313.040 / 30.709 / 3.693 |
| 单 run node | 157.540 / 1.844 / 0.994 | 313.040 / 1.844 / 0.993 |
| 单 run path | 157.540 / 1.413 / 0.779 | 313.040 / 1.413 / 0.776 |
| overview | 157.540 / 13.401 / 1.410 | 313.040 / 14.675 / 1.534 |
| source（2条 chunk） | 20.306 / 13.288 / 0.969 | 20.306 / 13.288 / 0.968 |

这是新增 GET，main 上没有同名接口的“改前”读量。实现期间 source 从重读整图的 176.766/332.266 KB，收窄到上表的 20.306/20.306 KB。500/1000 fixtures 的 prompt+report 全文分别为 8,199,500/16,399,000 B；这是被排除的合成正文量，不是假称旧版地图 API 实测。

上述初版测量的 collector 无决定来源时为 8 个批量查询，有来源的代表项目为 10 个；完整 page/node/path/overview 链路为 38 个 SQL statements（33 SELECT），source 为 35（30 SELECT）。每路 p95：500 runs 32.78–104.14 ms, 1000 runs 34.54–145.06 ms；这是同机 loopback，不是生产同区或用户端 p95。

2026-11-05 的生产 500 节点测量（固定部署 `86e35a1400cb`）返回正确，但 warmup 1209 ms、后续三次 1276/686/709 ms，未达到 500 ms 目标，也不足以宣称通过 p95。第一轮优化（#1452）把 GET 的每次 scope 解析合并为最多两个 authority DB 查询，并保留读前、读后的完整 ACL 重查；当时 metadata 在同一个只读 repeatable-read 事务内分批，collector 无来源 8→2 次、有来源的代表项目 10→4 次，跨批共享 1 MiB 的 SQL 预算。

当前成本优化（#1460）进一步把 collector 合为一条 SELECT，压缩 scope/issue/run 的内部传输，并把地图脱敏材料的 5 次读取合为 2 次。1 MiB 仍按压缩前的完整逻辑对象累计；所有拓扑事实、来源三态授权、读前/读后 ACL 与内容 fingerprint 保留。source GET 的专用授权链保持不变。

**collector 往返、完整 HTTP SELECT 数、完整 SQL statements 和生产延迟分别记录。** #1460 的真实 PG 回归中，100 issues + 399/899 runs + root 的精确 500/1000 节点首屏分别读取 64,604/99,554 B DB JSON，均为 8 条 SELECT；此用例使用缓存 session resolver stub 和真实启用的脱敏读取，未测 cookie 解析。原有 PAT 用例为 500/1000 runs（实际 502/1002 节点），page/node/path/overview 为 12 statements、9 SELECT，source 为 19 statements、14 SELECT。完整口径、CI 版本与生产改前 trace 见[成本回执](../acceptance/project-map-cold-read-cost-20261105.md)。隔离结果不代表生产修复后的延迟；生产结果须绑定精确部署版本并在 #1247 回填。

### 验收与交接边界

隔离回归包括共享 schema、真实 PG/HTTP 的 cursor/ACL/source、500/1000 规模、提交/回滚/幂等 live revision。正常应用验收另外使用实际 Next 与自动租用测试账号，记录固定 source SHA、origin、隔离数据库、资源清理、lease release 和 evidence audit；该结果写在 PR/issue，不拿 handler 集成代替。

生产验收按 #1245/#1247 各自的回执记录真实 Owner 两条订阅任务的决定、分叉/放弃、Artifact、同候选检查、原始来源，以及部署 SHA 和真实项目脱敏 JSON。当前代码和隔离结果不构成这项生产证据。本次 #1247 已获 Owner 明确授权建立专用、无 provider 执行的 synthetic 500/1000 节点规模 fixture；其测量与真实执行链验收分开记录，fixture 已按本次方案归档并保留运行历史。这项授权限于本次隔离 fixture，不构成后续任意生产数据写入的规则。
