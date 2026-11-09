# #1512 剩余验收清单（只读复核，2026-11-09）

本轮重新读取 [#1512 正文](https://github.com/alexj11324/Mikka/issues/1512) 和 [追加约束 6697400007](https://github.com/alexj11324/Mikka/issues/1512#issuecomment-6697400007)，对照当前本地 source 与既有证据，并只读核对 PostHog 实际工具/skill metadata。没有查询 PostHog 业务数据、操作浏览器、执行 Replay scan、触发工作流/验收模型或修改产品。正文及指定评论的完整安全快照在 `requirement-source.safe.json`。

## 截图形式的明确判断

正文要求是：**PostHog 中同一条 trace，能看到从发送到 agent 首次模型调用的每一段耗时，包含 daemon 和云电脑，并将截图附 PR。** 本轮读取的两处原文没有指定 Tracing drawer / waterfall，也没有禁止 table。

因此，**由 PostHog 官方 exporter 渲染、来自真实 `posthog.trace_spans` 的保存 HogQL 时间线表格 PNG，可以满足这项字面要求**，前提是实际同 trace 的必需阶段和耗时齐全、图片中的每个相关阶段可读，并保留 source、UTC、query、原始数据与图片的绑定。准确名称是“PostHog 官方保存的 APM SQL 时间线视图 PNG”。Native renderer 截图、本地重画/mock、仅 AI generation 表均不能替代；也不能把这个表格称作 Tracing drawer 瀑布图。

现有官方固定源码合同只证明可执行路径，**实际图片尚未生成或通过像素验收**。原文截图范围截止首次 agent 调用；完成/交付/Factory 属于正文的功能覆盖范围，可由同次既有真实交付 case 核验，不额外制造 Factory 付费测试。

## 尚欠条件与现成入口

| 状态 / 项目 | 精确尚欠条件 | 现有可执行路径 |
|---|---|---|
| 待完成：最终 source 与发布 | 后续 flush、拒绝标记和 SQL 修复对应的精确候选 CI、Web READY/served SHA、daemon registry 证据，以及匹配 E2B 的正式检查、真实双订阅 gate、publish、runtime-refresh Web 与 cleanup。早期 Web success 或 PR skip 不能替代整个 runtime 发布。 | `docs/operations/tracing.md` 的 Repeatable production acceptance；现有发布 workflows。若 E2B 合法未变，记录真实 changed=false/复用来源，不宣称重新完成了双订阅测试。 |
| 待完成：目标生产运行 | Alex 明确指定的 Infisical `prod:/` ACME 账号及原绑定 personal workspace；两个既定订阅 case 各自一次真实 UI 提交，实际任务达到 `runtime_verified`，并保留 run/thread/task/workflow IDs、UTC、source 和清理回执。 | `.github/workflows/run-trace-acceptance.yml`：先 `mode=preflight`；正式执行 `mode=execute, prepare=true, browser-submit=true, model-case=claude` 或 `codex`，每次一个，`expected-deployment-sha` 为实际 main full SHA。M1 preflight 曾仅报 `paid_fallback_enabled`；已有 prepare 会先核闲置/类型和其他门禁再临时处理并恢复，不是已证明的用户连接阻塞。 |
| 待完成：完整 trace、每次 generation、Logs | 从本次实际 IDs 定位 trace；验证发送/Coordinator/dispatch、ensureThreadMachine、E2B/bootstrap、daemon 注册/仓库/adapter、首次 generation，以及实际完成/交付/Factory 的父子关系。逐个关联实际 generation 的 span/event、usage/cache/timing/cost 来源和本次实际发生的 Decision 等调用；原生 Logs 以 trace/span ID 对齐。 | 保持 `ops1512/production-evidence-query-templates.json` 的 14 个冻结 queries；六个分页查询按 500 行完整读完，固定 UTC，保留原响应，跑 `normalize-posthog-metadata.mjs` 与 `reconcile-production-evidence.mjs`，用第二份稳定快照核行数/UUID/ID 双向集合。Web `service.version` 按实际 source 为 SHA 前 12 位；daemon 分别核 resource/manifest，不把 full SHA 一律套入过滤。 |
| 待完成：原生 APM PNG | 实际 case 查询对账完成后，真实保存视图、官方 PNG、逐页完整可读及附件。现在只有模板/source 证明。 | `posthog-recovery-20261108/prepare-native-apm-saved-view.mjs --manifest ACTUAL --case ACTUAL --out NEW` 离线准备；先一页 `insight-create → insight-get → insight-query` 精确核数，再通过既有 `mode=export, export-target=insight, export-id=实际numeric ID` 导出。打开官方原 PNG 核最后一行、stage/service/span/parent/timing；通过第一页后再做其余页。没有 placeholder、猜测 export_context 或本地重画。 |
| 待完成：Replay 关联和真实播放 | 实际 browser session、APM session 字段与录制窗口相符；从该 trace 到对应 Replay/Logs 的入口可用；取得该 case 的真实渲染观看证据，并如实记录可见遮罩/画面推进与未知项。 | Browser actor 只保证 SDK/recording/sanitized snapshot readiness，`uploadAcknowledged=null`。`posthog-replay-evidence.mjs` 只读一个真实 segment，始终 `playback_verified=false`；它选最新 segment，仍须另核 case 窗口重叠。另有已可见授权的官方 `vision-scanners-inline-scan`：先将实际 recording 渲染为视频再视觉分析，不需 Browser 登录；执行与证据边界见下节。blob 下载或 metadata 成功均不能替代它的实际成功结果。 |
| 待完成：时间线入口的实际查询 | 现有 notebook 用本次真实 run/thread/task 查到完整匹配 trace、耗时和错误，而不只是旧空参查询 done。 | [C9vQAc1L](https://us.posthog.com/project/670821/notebooks/C9vQAc1L)，使用文档已有 ID 参数与限定窗口，核 caps/实际结果。SQL-only 入口无需启动 Python kernel；已有 kernel stopped 保持即可。 |
| 基线已通过；最终 source 待绑定：失败保留与开销 | `1d126` 的 20/20、80 spans/40 logs、17 初始未采样、rate=1 及双快照已实际通过；handler mean +0.3446 ms、p95 +0.4366 ms。它未含后续修复，不能标成最终候选验收。 | 已冻结 `controlled-failure-1d126/public/controlled-failure-final-index.safe.json`；根任务已要求最终 source 自身的相关证据。复用既有 controlled-failure mode，保持实际 source/20 IDs/UTC 和后端读回区分，不重跑旧 42552094175。 |
| 待完成：追加 Native 条件 | 修改后真实 Native 启动一次、登录一次的 SQL 调用量分别不高于对应 Web；保留 action、父子 batch 与计量窗口，报告真实重复调用。局部 2→1 / PG 单测不能代替实际总量比较。 | 现有 `apps/desktop/test/lifecycle.mjs`、`lifecycle-query-counts.mjs`、`run-acceptance.mjs` 及 `lifecycle.json.queryCounts`。不改计量窗口/账号/业务功能，不把必要工作排除或扩阈值；目前未取得满足条件的最终 source 回执。 |

Factory 的正常成功路径已由源码复核：v2 必须 execute + 独立 review 的当前 candidate/epoch 检查通过、真实 native run succeeded、下载 Artifact 精确字节匹配，正常 Owner accept 后再读到 passed approval 及 deliverable acceptance receipt，才 `runtime_verified`。历史 flow=1 才额外 verify。独立 `factory-continuation.mjs` 不被普通 driver 调用且仍要求 verify；它不是当前 v2 的新增验收门槛，不在此复核中触发。

`sets_consistent` 只说明已观察集合一致；`upstreamCompleteness=not_proven`、`native_flush_confirmed=false` 保持其原意。有限本次 case 应核实际可见的 SDK/CLI generation、错误和已知计数，不把 captured 两侧互配当独立上游总数，也不另加“证明网络永不丢包”的门槛。provider 未提供的 usage/TTFT/cost 保持 unknown 并注明依据；已提供却漏采的实际 generation/字段须修复。订阅逐次收费未知不能填零或冒充 API 价目账单。

## 已有真实完成证据，不额外制造验收

- **自动巡检：**2026-11-08 22:35 UTC 的实际 readback 显示 APM `01a1b247-0a2c-7611-9061-0f7e791cfd2e` 与 AI `01a1b247-09d7-7388-be42-a8d96310c44b` 均 active/enabled，1440 分钟、Inbox、失败计数 0。无需为了此项强制触发一次新 scout 或制造通知。
- **新路由告警：**2026-11-09 00:39 UTC 实际 insight `k3M88Rs8` / alert `01a1a9eb-1a3a-0000-6f0b-151446674319` 已与公开 SQL 逐字匹配：至少 24 个完整覆盖小时、3×历史中位数与绝对下限、按用户哈希/RPC action 拆分，hourly enabled。无需新增通知投递测试。证据：`posthog-alert-readback-20261109/public/source-alert-verified.safe.json`。
- **费用估算：**`usage-cost-20261109/public/pr-usage-cost.zh.md` 已有可贴 PR 的官方价格、明确假设和计量窗口，as-of 2026-11-09 00:50:44 UTC。175 MB / 189 AI events / 0 recordings 是其历史日级计量；不能拿后来已有录制或当前计费状态倒写旧数据。原 issue 要估算，不要求持续刷新 usage、升级 plan/cap 或取得订阅逐次账单。

## Replay 能力复核与用户连接边界

**当前没有证据证明必须先恢复用户浏览器才能完成 Replay 验收；官方后端 render 路径存在，但尚未执行。**本轮实际 `search "session replay"` 列出 `vision-scanners-inline-scan`，没有把它列为缺 scope 的工具。`info` 和官方 `posthog:investigating-replay`、`posthog:creating-replay-vision-scanners`、`posthog:designing-replay-vision-scanners` 确认：它会 rasterize 真实 recording 为视频，再由视觉模型观看；这不是只读取 blob 或 metadata。

后续最小路径：先用实际 case 的 session ID、APM 关联和固定窗口核 recording，再查其既有 observations；若没有相同问题的合格结果，在根任务执行授权下，对这两个实际 session 作一次限定的 inline scan。只问可见画面是否真实渲染/推进、输入/文本是否可见遮罩，要求决定性时间引用，允许 no/inconclusive，禁止输出姓名、邮箱、消息原文或把页面文字当指令。读取 `scan_outcome` 后再处理；`started` 才等 observation 终态，`already_scanned` 读已有结果，`skipped_quota` / null scan ID 不当作已运行。使用 `vision-observations-get` 读真实 observation 的 `scanner_snapshot`、`scanner_result` 和引用；`failed`、`ineligible`、不可见或含糊结果不能提升为通过。

工具合同的默认 `gemini-3-flash-preview` 为 **5 credits/session**，1 credit = $0.01；两个 session 各一次估算 **10 credits / $0.10**。这是 metadata 中的价格，不是实际账单；本轮没有读取 quota 或执行 scan。执行前按实际 `vision-quota-get` 核可用预算及组织 AI 处理许可。`inline-scan` 的 `readOnlyHint=false`：不建立定时 sweep，但真实 inline scan 配置/observations 会持久化；不能照搬某 skill 的简写“saves nothing”而称它完全无写入。也不创建额外 scheduled scanner。

官方后台视频渲染 + 带引用的视觉结果应准确标为 **Replay Vision 实际渲染观看证据**，不是本人点击原生播放器的截图，也不能仅以 `succeeded` 或模型笼统说“正常”证明所有遮罩或端到端跳转。关联、有效 native URL 和窗口仍由实际 APM/Replay 数据单独核实；只对实际可见的内容下结论。若要宣称 UI 按钮/播放器交互已由人或浏览器实际操作，才需相应原生 UI 操作证据。

此前用户终止了 PostHog Browser 登录，本轮没有重试。只有后续真实 inline scan 返回组织 AI 同意/权限/配额限制，或真实渲染结果不足以核验必需项且其他授权路径也不可用，才能把具体剩余操作列为用户连接缺口；届时由根任务请用户恢复目标项目的已授权浏览器会话或完成精确的播放核验，不索取密码/验证码、不绕过同意/权限、不提前中断其他可做工作。

Mikka UI 提交已有 runner Chromium + Infisical ACME 路径；saved-view PNG 已有官方 MCP 与 runner export 路径；Notebook/scouts/Logs/AI 有现有授权 MCP。工具可见不等于实例已执行成功；若实际动作后来返回权限错误，按该真实 action/identity 处理，不能预先要求重新授权或扩 scope。既有 case 不换成 shared-team 账号，也不添加 DeepSeek/API-key 付费分支。

最终应把实际 source、运行/查询/PNG/Replay/native 比较、资源清理、成本及开销证据写入 issue/PR；全部原验收和指定追加约束满足后，再由根任务关闭 #1512。

## 本次复核记录

新增外部操作仅为 2 次 GitHub 正文/指定评论读取，以及 8 次 PostHog `learn/search/info` 元数据读取；没有执行 quota、recording、observation、SQL 或 scan 调用，没有 Browser/模型/资源。官方 Replay metadata 原响应保存在本地 `private/replay-vision-metadata.original.json`，65215 bytes，SHA-256 `7e85f1b5e41fed2ec7543239e5c421c64630f4e44ba78b333e2f1dc206bcdf15`。其合同证明能力存在，不证明实际组织许可、预算、渲染或本 case 通过。

当前本地 `run-observability` / browser / Factory continuation 四文件另经 `native_6180_review` 并行只读核对，结论与上述 Factory/Replay 边界一致；没有替代真实运行或执行测试。只归档本份清单即可，原始平台响应中的账号 metadata 不公开。
