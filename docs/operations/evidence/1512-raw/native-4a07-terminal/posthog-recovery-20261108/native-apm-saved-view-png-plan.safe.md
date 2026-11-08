# #1512：PostHog 原生保存 APM SQL 视图 PNG 准备

状态：**源码支持此路径，实际查询、导出和像素验收尚未执行。** 本次准备没有生产模型调用、生产 SQL、PostHog 对象创建、导出、浏览器登录重试或计算资源。

成品应称为“PostHog 官方保存的 APM SQL 时间线视图 PNG”。它使用实际 APM spans 和 PostHog 原生表格，由官方 exporter 截图；不能称作 Tracing drawer 瀑布图截图，也不能用本地重画、AI generation 表或模拟数据替代。现有 `native-apm-saved-view-source-review.json` 证明 HogQL 按实际表选择 Logs workload；本文件补齐表格显示、分页和执行顺序。

## 已确认的显示合同

官方源码固定在 `PostHog/posthog@c640dcd5e3ecd033f695f7d10a9e2fefb2572638`。具体 blob、原文片段和路径保存在 `native-apm-saved-view-rendering-contract.safe.json`。

| 项目 | 已读合同及其含义 |
| --- | --- |
| 原生节点 | `DataVisualizationNode`，`display: ActionsTable`，`source: HogQLQuery`。 |
| 表格默认分页 | `Table.tsx` 的 `DEFAULT_PAGE_SIZE = 500`。这不表示 500 行会全部出现在 PNG 中。MCP 节点 schema 没有 `pageSize`、截图高度或宽度字段。 |
| 导出渲染 | `ExportedInsight` 使用正式 `Query`，保存的 query/cached results，`readOnly`、`embedded`、`inSharedMode`，标题、说明和 PostHog 标识保留。 |
| 截图边界 | 非 metric 视图初始 800×600；后端量外层/body 高度和 table 宽度后调整 viewport，最高 5000、最宽 4000 CSS px。不会点击翻页，也不会遍历表格滚动区。 |
| 截断 | 表格 cell 使用 CSS `truncate`。DOM 中完整值或 hover title 并不能证明 PNG 中可见。必须检查真实像素。 |
| 返回列 | 固定源码的 `sourceTabularColumns` 遍历全部 SQL 返回列，仅取 `tableSettings` 的对应设置。因此 SELECT 本身只返回要显示的列，不能用 `columns` 来隐藏原始内容。 |

官方 MCP 的 querying-posthog-data、APM 表、SQL filters 参考及 docs-search 已读。business-knowledge-documents-search 在此 connection 未启用，记录了这一结果，没有反复探测。

## 实际 case 的输入

必须先按原来 14 条冻结 queries，使用该 case 的实际 run/thread/task/trace、部署版本和固定 UTC `[start,end)`，完成完整分页、normalizer 和两份稳定快照对账。保持这三份文件不变：

- `../ops1512/production-evidence-query-templates.json`
- `../ops1512/normalize-posthog-metadata.mjs`
- `../ops1512/reconcile-production-evidence.mjs`

本计划只消费既有 manifest，不修改原始查询、不再做 OFFSET capability probe。旧 baseline trace、schema fixture、空 placeholder insight 均不得用于生产验收。完整性判断仍以实际 case 的现有合同为准；`sets_consistent` 不被提升成上游永不漏采的保证。

## 1. 离线生成实际逐页请求

脚本只读取已有 normalized manifest，复用现有 reconciler，输出本地 JSON；没有网络调用、PostHog 写操作或 PNG 绘制。以下路径和 case label 必须替换成实际值：

```bash
node /workspace/scratch/812e3b7d6d45/issue1512-evidence-work/posthog-recovery-20261108/prepare-native-apm-saved-view.mjs \
  --manifest /ABSOLUTE/ACTUAL_NORMALIZED_MANIFEST.json \
  --case ACTUAL_CASE_LABEL \
  --out /ABSOLUTE/NEW_LOCAL_DIRECTORY
```

每页输出 `TRACE-pNNN.insight-create.json` 和 `TRACE-pNNN.expected.json`，总索引为 `plan.json`。这只是准备结果，不是查询回执或验收结论。

分页与时间计算的规则是：

1. 按 canonical `span_timeline` 的原始页面顺序，连续分成最多 8 行的显示页。原顺序是 timestamp、**base64** span ID、UUID；不能重新按 hex ID 排序。
2. 每页 SQL 用实际 row UUID 白名单选取该页；固定 trace、UTC 窗口、production 及两个服务过滤与 canonical 范围一致。没有 OFFSET。
3. `min(timestamp) OVER ()` 在完整 trace 范围内计算，之后才过滤 UUID 页，所以各页 offset 共用一个真实起点。否则第二页会错误地从零开始。
4. SQL LIMIT 为实际预期行数加 1，最多 9。任何额外行必须视为不匹配，不能刚好被 LIMIT 隐藏。
5. SELECT 只返回 `service, stage, offset_ms, duration_ms, status_code, span_id_hex, parent_span_id_hex`。标题/说明带实际 trace、UTC 窗口、行范围和总行数。ms 显示三位小数，原始数值仍在 raw/expected 中；status 0 是 Unset，不能计作成功。

所有真实 cloud 和 daemon 阶段都分页呈现。是否存在所需 API/Coordinator、Workflow/dispatch、ensureThreadMachine、E2B/boot、registration、repository/worktree、adapter、首次生成、completion/delivery/Factory 阶段，仍对照实际 case 和原始父子树验收。不要为了让图片看起来完整而补一条缺失阶段。

## 2. 只先创建、读回并验证第一页

在实际 case 数据已存在且逐页请求确认无 placeholder 后，把第一页 `.insight-create.json` 的内容作为官方 MCP `insight-create` 的输入。不要把外层模板 metadata 传给该 tool，也不要添加 dashboard、sharing、connectionId 或 export_context。

```text
call insight-create <完整的实际第一页请求 JSON>
call insight-get {"id":"<返回的真实 short_id>"}
call insight-query {"insightId":"<返回的真实 short_id>"}
```

上述尖括号是操作说明，不能原样调用。`insight-query` 当前 schema 没有 `format` 字段，不得凭描述自行添加。

读回必须确认 numeric `id` 是正安全整数，`short_id`、项目、完整 query、实际 trace、绝对 UTC 范围、UUID 列表、SELECT 顺序和 ActionsTable 设置相符。保存完整 create/get/query 响应。对真实 query 返回的七列，按顺序逐值比较该页 `.expected.json`；数字比较原始数值，不拿显示时的三位小数替代原始回执。span ID 及其 canonical UUID 绑定保存在 expected/SQL 中。

如果 query 返回错误、缺行、多行、不同次序或数值漂移，先解决实际不一致；不导出空白表，不更改 expected 来掩盖结果。若固定窗口数据发生迟到变化，回到原 14 条查询更新稳定快照和页计划。

## 3. 使用已有可信工作流导出实际 numeric ID

第一页真实查询匹配后，沿用现有 runner、Infisical key 路径和 expected-main-SHA gate，调用已有脚本：

```bash
node scripts/ops/posthog-export-evidence.mjs \
  --insight ACTUAL_POSITIVE_NUMERIC_INSIGHT_ID \
  --timeout-ms 180000
```

该脚本走官方 `POST /api/projects/670821/exports/`，body 为 `{"insight":123,"export_format":"image/png"}` 这样的真实 numeric ID 结构；这里的 123 只是类型示例，不能作为真实目标运行。后续沿官方 export ID/status/content 获取 PNG。不要把 short_id 传给 numeric-ID exporter，不新增任意网页截图、`export_context`、凭据或公开分享设置。

实际 insight 写权限、Logs/APM 数据权限、导出服务对该 query 的访问，以及 `export:write/read` 仍要由这次真实调用确认。工具存在和官方源码都不等于当前实例已成功执行。401/403/timeout 保留真实回执并由父任务沿已授权入口处理，不重试已中止的浏览器登录，不绕过权限；未知结果的 POST 不盲目重复提交。

## 4. 真实 PNG 像素验收

保存官方返回的原始 PNG、SHA-256、export ID/status、insight ID/URL、exact query hash 和 canonical page UUID 清单。打开实际 PNG，检查：

- 标题、trace、固定 UTC 窗口和页范围均正确，没有 loader、empty state、错误或过期结果。
- 页中每个真实 stage/service、span/parent ID、timing/status 均完整可读；最后一行可见，不靠 hover、隐藏 DOM 或假设滚动区域存在来判断。
- 行顺序和 query 回执匹配。offset 参考同一个全 trace 起点；未做本地时钟校正、因果关系重排或补齐缺段。
- 没有 prompt、response、工具参数、自由文本日志、原始 attributes 或 secret。
- 图片明确是一张原生保存的 SQL 视图，不标成 Tracing drawer 瀑布图。

8 行只是保守选择，不是源码证明的可见容量。如果确有纵向裁切，可用 `--rows 4`（或 1–8 中更小值）离线重建完整连续页，再查真实数据并重新导出。如果是宽列截断，减行数不会解决：需要把**实际 SQL SELECT**拆成同一 UUID 页的 timing 与 lineage 两个视图，两者保留 stage/service/span ID，再分别真实查询、导出和视觉核对。不能靠 tableSettings 隐藏列或本地拼接/重画来伪装成功。

第一页显示确实成立后，再依次处理其余实际页面，避免先创建一批尚不确定能渲染的对象。每页使用独立且可追溯的真实 query，不能导出一张图后悄悄改 insight 为下一页而丢失原查询。若复用属于本 issue/case 的对象，先 get 并完整保存旧版本/导出绑定，然后显式 update；不覆盖他人 insight。

## 5. 归档与判定

全部页面的 span/UUID 集合必须互不重复、并集等于 canonical timeline，行数与独立原始计数一致。所有相关 trace 都要覆盖，不能只取最容易展示的一条。PR 附官方 URL、原始 PNG 和页面索引，同时保留完整 raw/reconciler 收据。

截图证明的是这个实际 case 中 PostHog 已保存 APM 数据的官方视图。它不替代 generation/usage/error 对账、日志关联、Replay、失败保留或 scout 验收，也不会把 `native_flush_confirmed=false`、未知 usage 或未知 upstream delivery 升级为确定完整。最终 #1512 是否通过，由父任务按 issue 原验收统一判断。
