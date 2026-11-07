# #1512 PostHog 只读准备与实际 ID 执行顺序

准备完成于 2026-11-07 23:25 UTC；project 670821 / US。此文件只记录配置回读和待执行合同，不构成生产验收。主任务报告的真实生产 case 数仍为 0。主线变为 0479675e188efeac341b207d8616c4d7b9d4ee23 后的源影响审查由主任务处理；本轮读取的导出辅助代码来自候选 f3336eec99a9d8439668d516677c5389a95a7326，不能直接声称等于新主线部署。

## 已读回的配置

| 对象 | 实际回读 |
| --- | --- |
| APM scout 01a1b247-0a2c-7611-9061-0f7e791cfd2e | enabled=true，status=active，emit=true，1440 分钟，Inbox=true，Slack/Webhook=null，连续失败数 0 |
| AI scout 01a1b247-09d7-7388-be42-a8d96310c44b | enabled=true，status=active，emit=true，1440 分钟，Inbox=true，Slack/Webhook=null，连续失败数 0 |
| Notebook C9vQAc1L | v15；3 SQL，0 Python；5 变量；kernel=stopped |

APM 最近预检查为 2026-11-07T06:58:30.571703Z / run / 1 行；AI 为 2026-11-07T07:47:10.721056Z / skip / 0 行。这是各自历史预检查状态，不能推出当前模型事件缺失或 scout 已停用。配置开启不等于已观察到通知送达。本轮未运行 scout，没有修改任何人的配置。

Notebook 的 run_id/thread_id/task_id/trace_id 均为空，lookback_hours=24；3 个 done 状态属于 2026-11-06 的既有执行。入口：[Notebook](https://us.posthog.com/project/670821/notebooks/C9vQAc1L)。精确 SQL、node_id、变量、停机状态和安全历史元数据在配套只读回执中。

## 冻结的输入

证据来源是 evidence/1512-observability 分支的提交 d50353e8bd9cc77bc183a0a1c3d0de4d330ac255，下列文件位于 docs/operations/evidence/1512-raw/source85-profile1f-b527-8ff/：

| 文件 | Git blob |
| --- | --- |
| production-evidence-query-templates.json | 07f2013526784be3bff29fd23073f5320a980cf3 |
| normalize-posthog-metadata.md | 07f2b6ed95a0d004af24abc864368b651db55ebc |
| reconcile-production-evidence.md | 352be1f9838575ef2b5945da56f4289acee927e0 |

模板共有 14 条 SQL；normalizer 固定匹配这 14 条的哈希和投影。补充分布 SQL 不在既有 normalizer 接受范围，不能假冒既有 query 名、放宽解析器或改写原查询以跳过校验。

## 真实生产数据的精确顺序

1. 先确认新部署的 web、daemon、E2B 来源和实际代码版本，再按 #1512 的生产场景产生真实 run/thread/task/session IDs。记录真实起止 UTC、业务终态和本次资源清理终态。不得给不存在的阶段补造 span，不以候选或旧部署案例替代新部署验收。
2. 固定一组真实 IDs 和 UTC 半开窗口 [start,end)。普通窗口不超过 1 小时；确因真实运行时长需要加宽时先记录理由。trace 必须为非零 32 位小写十六进制；不要在查询期间滚动窗口。APM/Logs 中 trace/span ID 为 base64，AI 中为 hex；只做可逆精确转换。
3. 每个完整快照先执行 lookup_trace_count，再枚举 lookup_trace_by_ids 的所有页；对每个发现的 trace 执行下表 8 个消费表。两次快照必须同一 scope、完整收集，分别记录完成时间；不能只重查 count。原始请求与原始 MCP response JSON 必须分别保留。
4. execute-sql 请求使用精确替换后的 query、truncate:false 和可选安全 context；不加 connectionId/sendRawQuery。truncate:false 控制大单元格，不能证明行集完整。六条分页查询的 offset 为 0、500、1000…；每个非末页恰为 500 行，末页小于 500；恰好 500 行也必须真实读取后续空页。独立 aggregate 使用 offset 0 的一页。
5. 对每页执行既有 normalizer；例如：node normalize-posthog-metadata.mjs --query span_timeline --input saved-raw-mcp-response.json --request saved-request.json --output normalized-page.json。输入必须是原始 MCP result JSON，不能是手工复制表格或重建响应。保留实际列、UUID、null/0/boolean 差异；truncated 始终按当前合同为 null，不能改成 false。
6. 在第二个稳定快照附近，每个实际 trace 额外执行一次 supplemental-service-environment.prepared.sql；只替换其固定实际 trace 与相同 UTC 窗口。该 SQL 不预先限制服务/环境，只返回 4 个闭式服务类 × 7 个闭式环境类及 count，最多 28 组，LIMIT 32 不会切掉合法分组。不返回任意服务名、环境值或完整 attrs。
7. 校验补充结果恰有 service_class/environment_class/span_rows 三列，枚举合法、组唯一、计数为非负安全整数。总行数必须等于对应 trace_integrity.span_rows 且大于 0，所有组应符合经新源审查确认的生产服务。other/missing/非 production、额外服务或 count 不一致都需要具体调查，不能被旧的双服务过滤吞掉。该检查只覆盖该实际 trace，不能证明不存在另一个孤立 trace。仅在发现迟到数据或差异时重取受影响证据，不预设循环查询。
8. 使用两个完整快照组装 manifest：schemaVersion=1、projectId=670821、固定 window、ids 中 run_id/thread_id/task_id 三字段均存在；snapshots.before/after 各含 capturedAt、lookup、lookupCount 和全部 traces。执行 node ops1512/reconcile-production-evidence.mjs manifest.json reconciliation.json。CLI exit 0 仅证明已捕获集合、计数和两快照内部一致，不代表整体生产验收。upstreamCompleteness=not_proven、overallAcceptance=null 等边界必须保留。
9. 独立核验 tail_error_retention、source_correlation、apm_session_links、replay_correlation；reconciler 不消费这四项，出现于 manifest 不代表已评估。结合实际源版本、阶段父子关系、闭式错误保留、真实 AI usage/cost/TTFT/flush/native collection、应用日志和 Replay 链接逐项满足 #1512。查询、PNG 或脚本成功都不能取代这些验收项。
10. 若两完整快照发生迟到数据变化，待明确 ingestion 稳定后重新收集两份完整证据；不要为补证据再运行一次模型。最后归档哈希、原生链接、运行版本、清理结果和每项已验证/未知/失败结论，再由主任务决定关闭 issue。

| 必需表 | Cluster |
| --- | --- |
| span_timeline / trace_integrity | Logs |
| safe_native_logs / capture_summary | Logs |
| apm_generation_spans / native_generation_collection | Logs |
| generation_receipts / ai_capture_summary | Default |

lookup_trace_by_ids 与 lookup_trace_count 均为 Logs。六条分页查询是 lookup_trace_by_ids、span_timeline、generation_receipts、safe_native_logs、apm_generation_spans、native_generation_collection。capture_summary 必须恰有三条固定信号行，其他独立计数聚合各为一行。Logs 与 Default 不可跨 cluster JOIN；离线比较原始身份集合及准确配对，尤其 AI 与 APM generation 的双向集合，不能只比较数目。

## Notebook 的实际 ID 入口

notebooks-set-variables 是全量替换变量列表，并不会自动重跑。真实 ID 到来后保留以下 5 个变量的名称与类型：run_id/string、thread_id/string、task_id/string、trace_id/string、lookback_hours/number。为证明单个 ID 入口，应每次只填相应真实查询键，其余字符串为空；lookback_hours 设为覆盖该真实运行的 1..336 整数。trace_id 填 hex。

- 时间线 SQL node_id：3f5a1c64-b0de-4a32-be51-341666af8a79。
- 日志 SQL node_id：3c4b2757-6de2-4d50-bfe8-0b6991b68b00。
- 最近运行 SQL node_id：8f15f2e8-8c0b-4505-b0d7-e6150c8d5cb3。

调用 notebooks-run-cell {notebook_id:"C9vQAc1L",node_id:<实际目标>}。若返回运行中，只对其真实 run_id 调用只读 notebooks-run-cell-result {run_id,short_id:"C9vQAc1L"}。notebooks-run-status 会写 cell 结果，不能拿它当只读 kernel 状态接口。此 Notebook 没有 Python/依赖 Python 的单元；实际执行后再用 notebooks-get 回读结果和 kernel，确认 stopped。无需调用 notebooks-configure-compute。

Notebook 的相对窗口、matched_traces LIMIT 100、最近列表 LIMIT 40、时间线 LIMIT 2000、日志 LIMIT 1000，以及预先限定双服务，决定它不能作为完整枚举证据。实际原生页面还需视检可用性。

## 原生 PNG 导出和 Replay

候选代码已有 .github/workflows/run-trace-acceptance.yml 的 export 模式及 scripts/ops/posthog-export-evidence.mjs。它只支持真实 saved dashboard/insight 的正整数 ID，通过官方 exports API 创建 PNG；不支持把任意 URL、Notebook 或 APM trace 直接交给 exporter。必须先核对已保存目标确实指向此次实际 trace 与固定窗口；工具能力检索没有发现原生 PNG 专用 MCP 等效入口。

现有路径在 main dispatch、8 分钟 job 内运行；加载 runner 上 Infisical prod:/platform 的 POSTHOG_PERSONAL_API_KEY，精确校验 EXPECTED_DEPLOYMENT_SHA===GITHUB_SHA 后才能取密钥。先单次 POST /api/projects/670821/exports/，再有界 GET 状态和同源 content；不在丢失 POST 响应时盲目重试。所需 scopes 为 export:write/read，实际 key 是否具有权限尚未验证。脚本校验目标 ID/type、PNG 格式、32 MiB 上限、头尾块、尺寸和 SHA256，但不会替人观察画面。真实 PNG 必须视检实际运行、时间窗口、是否空白/截断；不能用 PNG 文件签名代替这一项。artifact 名 run-trace-posthog-<workflow_run_id>，保留 7 天；需按证据流程及时归档。

现有 scripts/ops/posthog-replay-evidence.mjs 只做录制 metadata、sources、一个 blob_v2 segment 的 3 次 GET，输出 one_recording_segment、requires_apm_match、playback_verified:false；不会呈现 event.data。它可以保留安全 metadata 和哈希，不能证明可播放或遮罩。

真实 session 到来后，按 replay-playback-masking.prepared.json 使用官方 vision-scanners-inline-scan 的单次闭式核验合同：先查已有对应 observation，检查 quota，再按需发起一个 session 的 inline scan。它不创建定时 sweep，但会持久化 observation 并可能消耗 credits。scanner 返回的 scan_id 是 scanner ID，observations-get 需要 observation ID。本轮只读取 schema，没有调用任何 scanner、quota 或 observation 数据接口。

核验只允许 playback_observed、unmasked_input_visible、unmasked_message_visible、input_masking_observed、message_masking_observed 的 boolean/unknown，不转录输入或消息。API 没有强制 response schema，实际输出路径也尚未见到；自由文本/额外字段不得进入证据，无法闭式解析即 unknown。视野缺失、空白区域和 scan succeeded 都不能当作遮罩或播放通过。自动视觉观察的覆盖范围仍需记录；#1512 如要求实际原生播放器检查，不能将 metadata 或模型成功状态替代它。

## 未知和资源

未知：新主线实际生产源/阶段集合、实际 IDs、14 模板新增 count 的真实返回、补充 SQL 的实际返回、two-snapshot 稳定性、当前 exporter key 权限/实际渲染、原生 PNG 内容、Replay 实际播放/遮罩及视觉覆盖。没有真实 ID 的项目均未提前查询。

本轮应用模型调用、Notebook 单元执行、compute 启动、Sandbox 创建、PostHog 配置修改、Git ref 修改均为 0。Notebook 在本次回读中为 stopped。只读证据以 Git blobs 交给主任务统一归档；本子任务不再轮询。
