# Batch 1615 离线数值归因器 v2

这是新写的离线工具，不是旧 schema3 分析器的字节恢复。它没有网络、SQL、模型、资源或验收控制能力，不导入产品运行时。生产结果仍未采集；本目录的测试全部使用合成输入。

## 使用

1. 保存两份原始 continuation wrapper：continuation-cache[-live]-haiku-{sha8}.json 与 luna 对应文件；可另加最多两份 ordinary-stop wrapper。不要使用 standalone coordinator-cache-turns-haiku.json：历史 driver 在 Luna 早失败时可能写入这个默认文件名。
2. 从 wrapper.observation.turns[index] 取得每个实际 workflowRunId；六个 cache 槽固定为 Haiku/Luna × 1、2、3。失败、未发送、未运行的槽保留。普通 Stop 的两个槽独立，不能混进 warm 分母。
3. 最多八个唯一 exact-wrun，每个只保留一份既已获准的原始日志 capture。manifest 的 applicationSha、deploymentId、时间范围与 SHA256 必须填写实际值，不从文件名推断。若查询截断/达到分页边界或完整性不明，complete=false，不再由此工具查询。
4. 以 manifest.example.json 为格式模板，填入实际来源与本地路径、SHA256；运行：
   node aggregate.mjs manifest.json report.json
5. 查看 warmAcceptance 四槽逐项结果，而非均值。必须四槽均为 observed、已发送、wrapper 成功、前后版本匹配，且客户端 firstTextMs ≤3000。runtimeCompleteness 是已知 run 的日志覆盖情况，不等于性能或 Stop 验收通过。

所有文件 SHA 是原 UTF-8 字节 SHA256。输入最大每件 16 MiB、最多八份 capture。重复 capture、跨槽复用同一 run、错误部署/版本/哈希、未知 run、错误完整 streamId 均拒绝。失败输入原件保持，不以过滤错误行获得成功。

## 日志字段与关联

只识别三个实际 producer：
- model_call_timing：workflowRunId 必须完全相等。保留所有 stepId、attempt、interrupted、usage/rawCache 状态与 subscriptionStages；同时保留实际 producer 的闭集 route/model/finishReason 和严格 prefix 哈希；重复事件保留并标 duplicateOf，不取最快/最后一项冒充整轮。
- turn_timing：同样按 exact workflowRunId；事件钟 phase 与 Node body 时间分开。
- coordinator_stream_projection_timing：必须匹配完整 wrun_ID:round 格式；不按 startsWith 或时间邻近认领。requestId 只取日志 envelope；多个 HTTP 投影或缺少 requestId 保留为不唯一，不能自动挑一个对应客户端。

每个日志文件可为明确 JSON/JSONL、JSON fences，或含这些明确数据的 MCP result/content 外壳。structuredContent 与 content 的镜像仅选一个外壳；真实重复记录不删除。**当前没有已恢复的真实 Vercel Markdown布局样本**，工具不会猜表格列或从任意 prose 中抽取 JSON。未知布局输出 unsupported_or_empty / complete=false；以后仅凭已经取得的原件做纯离线窄适配，不追加查询、不补零。

可先由人工离线抽取明确 JSON 记录，但必须保留原 capture 与 SHA，并在审核中说明抽取来源；不能把未经审核的人工文件称为原始工具响应。

rawCache missing 表示该 producer 最后取得的 usage 未含此字段；不是已证明 miss。null、invalid、number(0) 四种状态不同。SDK 可能已把未报告归零；多个 provider usage 在 SDK 内的覆盖不会被本工具恢复，仅保留实际已记录的所有 model 日志。

仅输出既有闭集数值、固定枚举和必要 ID。不输出提示词、正文、credential、secret fingerprint digest、provider 错误文本。prefix.tools/system 仅允许实际 producer 的 12 位小写十六进制请求内容摘要；它与 secret fingerprint 无关。route 仅 hosted/subscription；model 仅实际 fixture 的 claude-haiku-5-5 / gpt-6-luna；finishReason 仅 stop、length、content-filter、tool-calls、error、other、unknown。其余值保持 invalid，不回显原字符串。prefix 整体以及 tools/system 的 missing、null、invalid 分别保留。pre-layout 哈希的变化只能识别缓存前缀变更候选，不能单独证明 hit/miss 或实际 wire 完全相同。原件 SHA 可用于追溯失败，failurePresent 不冒充具体原因。未知 subscription 字段丢弃；不合法数值保留 invalid，missing/null 保留各自状态。最多保留 producer 合同内 16 个 worker，同时保留 overflow 和 suppliedWorkers；超合同数组标 invalid。

## 时钟：来源固定 0d379dd92fd2d7b3f2b307030c3bcd8234426d0e

- 客户端 firstTextMs：本次发送的 performance.now，仍是 3 秒标准。
- model_call_timing：setupMs 保留原起点；firstToken/firstText/duration 相对 resolver 成功后重置的 requestedAt。firstText 是 SDK text-delta 事件，通用计时器未独立验证非空。
- 0d subscription collector：在 prefix/layout/stepIdentity/resolve **之前**创建；withSubscriptionTiming 仍在 resolve 成功后才进入。stage offsets 包含等待到该上下文的时间，却不捕获 resolver 内部 child。不能使用旧 43fef/e0 的 post-resolve collector 起点解释它。setup 拒绝不产生该 model 日志，不能伪造零或等待日志。
- Go RPC firstEmit 等从各 child 自己的入口算；Go HTTP headers/event/text/converted 从 client.Do 前算。provider text event 明确要求非空。嵌套 span 不相加。
- projection raw/emitted/committed 是同一 HTTP 实例内相对开始值，具备同实例证据后可以人工比较 raw→emitted；不能与模型或客户端跨钟直接相减。
- Workflow phase 事件跨度、successful composite preparationBodyMs、context execution/personal/github Node body 时间分别展示。工具不计算任何跨钟差、残差或加总。

若 future app SHA 不同，root 必须先验证这些 producer 的实际源仍同本 profile；本工具不会拿 Git ref 新旧替代真实版本 fence。source-proof.json 记录精确 Git blob/SHA；expectedSha/deploymentId 模板留空，未预填未来生产版本。

## 已授权采集的 payload 模板（本工具不会执行）

get_runtime_logs({
  link_id: <existing link>, teamId: <existing team>, projectId: <existing project>,
  deploymentId: <actual deployment>, environment: 'production',
  query: <one exact workflowRunId>, since: <bounded ISO>, until: <bounded ISO>, limit: 100
})

保留整个 CallToolResult；structuredContent.content 可能为 Markdown，不应先当 JSON 对象解析。不要为缺失 projection 自动另查 requestId，也不要把按 wrun 查询没有返回的 projection 当作 holdback=0。Go 数值位于 model_call_timing.subscriptionStages，不需要另发 Go 查询。

## 验证与边界

node --test aggregate.test.mjs

十一项独立离线场景验证六槽/四 warm 门槛、失败/未发送、重试与多 usage、missing/null/invalid/overflow、不回显未知内容、重复/错误来源拒绝、完整 scoped projection、多 HTTP 歧义、未知 Markdown、普通 Stop 独立分母。原历史生产数值与旧分析器均未改写，旧测试成绩不转移到本工具。本工具无产品变更，亦无 PG 门槛；真实日志布局和真实新生产结果均尚未验证。

## v2 修订与反证

v1 完整冻结保存在 v1/，其 freeze-manifest.json SHA256 仍为
927de16d61a9419e7b513a28a87a55c4a8d6e0abc941cc5caf71ca8447e003c0。
原通过日志未覆盖。

v2 仅修两处实际审阅问题：
1. 每个显式 JSON/JSONL 候选、坏 fence 及未闭合 fence 单独计失败；一条有效记录不能掩盖旁边损坏记录。保留可解码记录，同时 complete=false。
2. 补回上面的闭集模型元数据与 12 位 prefix 哈希；保留所有 attempt，不以任意未知字符串换取更多字段。

新增两项测试先对完整 v1 源运行，均真实失败；其中 JSONL/fence 混合损坏显示旧解析会遗漏 incomplete，prefix 用例显示旧输出缺失该合同。随后最终 v2 跑原九项与新两项，共 11/11 PASS、0 skip。针对 v1 的隔离临时副本已经清理；v2-red.log 与 v2-green.log 及各自 exit receipt 保留。v2-v1.patch 给出准确修订。没有调用任何生产查询或新增模型样本。
