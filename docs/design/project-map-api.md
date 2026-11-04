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

生产验收通过既有 GitHub OIDC 读取 Infisical 的 smoke 账号，正常登录；凭证仅在环境和进程内存。三条路径分别记录 API deepseek-flash、Claude 订阅 claude-haiku-5-5、Codex 订阅 gpt-6-luna 的结果。API 余额不足独立记 BLOCKED。订阅需先证明原 thread 仍工作，再真实插话改变方向，核对工具记录、实际执行身份和产物；只列出模型、只读工具目录或结束后续跑不算这项通过。

完成记录以对应 issue 的 PR、commit、Web deploy、生产 version 和脱敏验收报告为准。
