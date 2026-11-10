# 任务运行页右栏 API v1

本文供前端接入时间线、Agents 和产物三个页签。一次请求取得同一权限范围、同一数据库快照的数据；前端不必逐个查询运行或解析原始生命周期事件。

## 请求与刷新

`GET /api/factory/tasks/:taskId/activity`，路径参数 `taskId` 为 Factory task UUID，无查询参数或请求体。复用现有包含工作区上下文的请求通道和登录会话，请求带任务所在工作区的 `x-mikka-workspace-id`；工作区选择沿用 [现有客户端请求层](../../lib/web-connection/client.ts)，无需在右栏另写认证逻辑。通过 `withBasePath` 构造请求地址；默认前缀下实际地址为 `/mikka/api/factory/tasks/:taskId/activity`。响应里的 `url`、`downloadUrl`、`posterUrl` 已带前缀，直接使用。

响应头为 `Cache-Control: private, no-store`。权限沿用任务详情的 owner、Bot/source、issue 和工作区边界；知道 task、run 或 capture ID 不授予访问权。显式工作区选择优先于 cookie；未显式选择时沿用会话工作区选择。cookie 选到其他工作区、无效的显式选择，以及个人访问令牌（PAT）的固定工作区与请求头不一致，均不能读取此任务。工作区切换后按现有请求层退役旧响应，不去掉工作区条件重试。

浏览器会话与 PAT 均只返回当前有效工作区中的运行、电脑区间、等待记录、产物及 flow 内嵌引用。文档同时核对版本提交者和 Artifact 的持久化 `workspaceId`；电脑区间要求 task、run 和租用记录的持久化租户一致，并保留原有 Bot/custody 校验。`workspaceId = NULL` 的历史数据保持隔离，不从创建者、旧 Team link 或电脑绑定推断访问权。原文件及封面采用相同限制；成员撤销后，既有对象或封面缓存不授予访问权。

首次进入读取一次。沿用 `useLiveKey('factory_task', taskId, [activityKey], liveWorkspaceId)` 使现有 live 通道失效缓存；`liveWorkspaceId` 来自本响应，可以为 `null`。运行领取、首次开始输出、完成、文档提交、VM 区间与媒体就绪写入在提交后通知同一任务 key；逐个文本片段不会刷新整个右栏。无需逐个订阅 run 或猜测其工作区，不增加 `refreshInterval`、定时 fetch 或轮询。等待时长需要持续显示时，在客户端按 `observedAt` 推进时钟。

## 响应结构

顶层字段如下。时间统一为 ISO 8601 字符串；缺失时间保留 `null`。

| 字段 | 含义 |
| --- | --- |
| `version` | 右栏接口版本，固定为 `1`。 |
| `observedAt` | 本次快照的服务器时间。 |
| `liveWorkspaceId` | live 订阅工作区 ID，或 `null`。 |
| `task` | 原有 flow v2 投影，加任务状态及时间字段。其 `version` 仍为 `2`。 |
| `timeline.attempts` | 全部 attempts，按 `position`、`id` 排序，包含没有绑定 run 的控制阶段。没有最近 20 条截断或分页。 |
| `timeline.computers` | 该任务所有运行的已记录 VM 租用区间，按开始时间排序。 |
| `timeline.waits` | 已记录的等待区间，按开始时间排序。 |
| `agents` | 每个绑定有效 run 的 attempt 一条，按 attempt 顺序排列；同一 Agent 可以出现多次。 |
| `artifacts` | 文档提交版本、全部 ready 截图/录屏及 PR，按创建时间、稳定 `id` 排序。 |

`task` 保留 flow 的 `id`、`issueId`、`botId`、`revision`、`stage`、`stages`、可选 `needsYou` / `completion`，以及 `review`、`acceptance`、`pullRequest`。具体含义见 [flow v2 合同](1276-flow-v2.md)。`needsYou` 直接沿用 flow；不要从 attempt 的 `status` 重新猜任务是否需要人处理。

额外任务字段如下：

| 字段 | 含义 |
| --- | --- |
| `status` | 已存储的生命周期状态；任务主阶段标签仍使用公开 `stage`。 |
| `createdAt` | 任务创建时间。 |
| `startedAt` | 最早的有效 run 开始时间；尚未实际开始为 `null`。 |
| `endedAt` | 当前候选的合并确认、交付验收，或取消/撤销的持久化时间。 |
| `endedAtSource` | `merged`、`accepted`、`cancelled`，或 `null`。 |

合并时间来自服务端记录的确认时间，不冒充 GitHub 的精确 `merged_at`。没有终态收据时，即使历史 task 状态已终止，`endedAt` 与 `endedAtSource` 也保持 `null`；不得用 `updatedAt` 或旧 run 的结束时间补造任务结束时间。

## 时间线与 Agents

attempt 和 Agent 共用以下展示字段：

| 字段 | 含义 |
| --- | --- |
| `stage` | 公开阶段：`triage`、`spec`、`implement`、`review`、`handoff`。 |
| `role` | `plan`、`implement`、`review`、`fix`，或控制阶段的 `null`。 |
| `title` | 已脱敏的一句话标题，最多 200 个字符；来自完成摘要、完成投影摘要或原因，缺失为 `null`。 |
| `revisionOf` | 本次修复针对的先前 implementation attempt ID，或 `null`。 |
| `candidateId` | 候选 ID，或 `null`。 |
| `artifactIds` | 指向本响应 `artifacts[].id` 的关联数组。 |
| `plan` | `{ artifactId, version, url }`，没有已验证方案引用时为 `null`。 |
| `createdAt` / `startedAt` / `endedAt` | attempt 或 run 的时间；含义见各集合说明。 |

`timeline.attempts` 另有 `id`（attempt ID）、`runId`（可为 `null`）、`position`、`status`。有 run 时开始/结束时间使用 run 时间；没有 run 时结束时间使用 attempt 的完成时间。attempt 被取消后，仍保留它实际执行的阶段。

`agents` 另有 `attemptId`、`runId`、run 的 `status`、`agentId`、`name`、`harness`、`model`，以及 `machine: { id, name, kind } | null`。创建、开始和结束时间均属于 run。显示名及机器信息允许缺失；不要把缺失 model 推断成某个默认模型。

公开 stage 复用 `publicFactoryStage`，与已有 attempt stage 要求是一套映射，没有第二组数据库列：

| 原始 stage | 公开 stage | 基础 role |
| --- | --- | --- |
| `clarify` | `triage` | `null` |
| `spec` | `spec` | `plan` |
| `execute` | `implement` | `implement` 或收据证明的 `fix` |
| `review` | `review` | `review` |
| `verify` | `implement` | `review` |
| `approval` / `publish` | `handoff` | `null` |
| `monitor` | `handoff` | `review` |

role 来自阶段和创建 attempt 的宿主收据。基础设施重试继承原角色，新 owner request epoch 重新开始 implementation；ordinal 大于 1 不代表修复。缺失历史不会生成虚构的 `revisionOf`。

### 电脑区间

`timeline.computers[]` 为 `{ id, runId, startedAt, endedAt, reason, source }`。同一 run 可以有多次租用。`reason` 是区间结束原因，未结束时为 `null`：

| `reason` | 含义 |
| --- | --- |
| `paused` | 机器暂停。 |
| `retired` | 机器退役。 |
| `provider_missing` | 服务端确认 provider 上的机器已不存在。 |
| `transferred` | 机器转交给另一 run。 |
| `replaced` | 绑定的机器被替换。 |
| `scope_changed` | 原工作区或 Bot 范围已变化。 |

`source` 为 `running_since`（记录的运行起点）、`observed`（观察到新绑定的时间）或 `running_since_backfill`（已有数据能证明的历史区间）。没有可靠租用历史的旧运行可以没有区间；不要把 `computer_run_bindings.createdAt` 当作每次真实租用起点。

### 等待区间

`timeline.waits[]` 为 `{ id, kind, attemptId, runId, startedAt, endedAt, durationMs }`，其中关联 ID 可以为 `null`。`kind` 沿用 `needsYou.kind`：`spec_review`、`question`、`pr_review`、`blocked`、`failed`。

区间来自任务转换收据和实际升级给人的 execution question。`durationMs` 截止到 `endedAt`；开放区间截止到本次 `observedAt`。没有早期收据的任务仍可沿用 flow 的当前 `needsYou.since`；前端不必另开接口计算等待时间。

## 产物和打开方式

按 `kind` 区分条目，列表 key 和关联查找均使用条目的 `id`：

| `kind` | 特有字段与稳定 ID |
| --- | --- |
| `plan` / `acceptance` / `document` | `artifactId, format, title, runId, attemptId, candidateId, version, size, createdAt, url, downloadUrl`；`id = artifact:ARTIFACT_ID:vVERSION:ATTEMPT_ID`。 |
| `image` / `video` | `captureId, runId, attemptId, contentType, source, title, size, durationMs, createdAt, url, posterUrl`；`id = captureId`。 |
| `pull_request` | `runId, attemptId, candidateId, title, state, createdAt, url`；`id = pr:RUN_ID`。 |

文档按不可变提交收据归属到 run/attempt。一个 Artifact 跨修复生成多个版本时，保留多个稳定条目；不要按 `artifactId` 去重，也不要把所有版本归到最初创建它的 run。与当前候选验收记录匹配的版本标为 `acceptance`，其他历史版本仍可作为 `document` 展示。

文档 `url` 打开现有 Artifact 窗口；窗口使用普通 Artifact 导航。需要确切历史内容时使用该条目的 `downloadUrl`，它固定到 `version`。`plan.version` 同样固定完成方案的版本，后续人工编辑不会改变该引用。

媒体包括任务所有运行的 ready 截图和录屏，不限验收报告引用的 40 条。原文件地址为 `/mikka/api/factory/tasks/TASK_ID/media/CAPTURE_ID`。图片 `posterUrl` 为 `null`；视频的 `posterUrl` 在原地址后加 `/poster`，可接到 `<video poster>` 或封面图片。

视频封面首次访问时按原视频摘要生成 JPEG，后续使用私有派生缓存；activity GET 本身不读取媒体字节或生成封面。原文件和封面使用同一任务访问控制，读取完成后再次检查权限。所有媒体响应均为 `private, no-store`；服务端封面缓存不表示公开访问权限。封面暂不可用时保留视频入口，不生成虚构封面。

## 错误处理

activity 错误响应为 `{ error: string }`：

| HTTP | `error` | 前端处理 |
| --- | --- | --- |
| `401` | `authRequired` | 使用现有登录恢复流程。 |
| `404` | `factoryNotFound` | 任务不存在、ID 无效或权限不足；使用同一不可见状态。 |
| `409` | 对应的 Factory 错误码 | 交给现有本地化错误处理，不当作空数据成功。 |

未知服务端故障走现有路由错误处理。媒体端点成功时返回字节；错误按状态码处理：`401` 未登录或凭证失效，`404` 工作区/权限不匹配或文件缺失，`503` 解码或存储不可用。拒绝响应可能无正文，也可能来自任务详情共用的工作区错误适配器；不要要求媒体错误一定能解析为 JSON。

## 历史方案回填

正常 spec 完成事务保存方案 Artifact，并写入 `attempt.output.specArtifact`。历史记录使用显式命令行回填；GET 不写方案数据，也不会自动运行回填。命令的存在不表示生产回填已经执行，实际结果以发布 owner 的执行记录为准。

在已配置应用数据库、工作区数据库和 Artifact 存储的环境中检查一批：

```bash
node --conditions=react-server --import tsx \
  scripts/ops/backfill-factory-spec-artifacts.ts \
  --user-id OWNER_ID --limit 50
```

将 `OWNER_ID` 替换为要处理的任务所有者 ID。默认 dry-run；单批最多 100 条。输出含 `scanned`、`wouldCreate`、`created`、`existing`、`skipped`、本批 `cursor` 和下一批 `nextCursor`。使用相同 owner、limit，加 `--cursor BATCH_CURSOR --apply` 应用检查过的批次；将 `BATCH_CURSOR` 替换为本批输出的 `cursor`。继续下一批使用 `nextCursor`。

回填先按任务的持久化工作区取得成员租约，再开始应用数据库事务并重新检查 owner、来源和 grants；跳过不再授权、租户未归属或来源失配的记录。重复执行不重复创建版本，历史模式不发送新的 Artifact 提交事件或启动模型 turn。执行后通过 activity 中对应 attempt 的 `plan` 和精确版本下载确认结果；权限已撤销的历史方案可以继续为 `null`。

## 合同来源

字段以 [activity.ts](../../lib/factory/activity.ts)、[activity-artifacts.ts](../../lib/factory/activity-artifacts.ts)、[task-media.ts](../../lib/factory/task-media.ts) 和 [HTTP 路由](../../app/api/factory/tasks/[taskId]/activity/route.ts) 为准。数据库覆盖见 [activity.db.test.ts](../../lib/factory/activity.db.test.ts) 与 [spec-artifact.db.test.ts](../../lib/factory/spec-artifact.db.test.ts)。
