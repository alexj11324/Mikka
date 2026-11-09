# #1512：1d126 受控失败 OTLP 与开销基线

**这次有限受控验收通过：20 条实际失败 trace 均在 PostHog 读回，80 个 span、40 条 ERROR log 与 runner 的实际 ID 集逐条一致，没有缺失或物理重复。** 结论只绑定 `1d1261b607c8d60a27e2131ef59b463156d346d1`。该版本尚未包含后续 flush、返回型拒绝标记及 SQL 优化；这不是这些修复的验证，也不是 #1512 最终生产模型验收。

## 来源与范围

- GitHub [run 42552094175](https://github.com/alexj11324/Mikka/actions/runs/42552094175)，attempt 1，`controlled-failure` job `128949713707`，精确 main head `1d1261b607c8d60a27e2131ef59b463156d346d1`，最终 `success`；另外两个 job 合法 skipped。
- runner 实际执行窗口：`2026-11-09T02:43:10.028Z` 至 `2026-11-09T02:43:11.147Z`。
- PostHog project `670821`，`environment=dev`、`service=mikka-web`、`service.version=完整 40 位 SHA`；固定查询窗口为 `[2026-11-09 02:43:10, 2026-11-09 02:43:12)` UTC，仅包含 artifact 中的 20 个实际 trace ID。
- 请求是普通 `GET /api/trace-benchmark`，每次在自有 loopback PostgreSQL 执行三条查询，其中一条受控除零失败。没有生产用户请求、账号修改或模型调用。
- source 文件、Git blob 及 SHA-256 见 [source-binding.safe.json](source-binding.safe.json)。原始 runner 回执见 [controlled-failure.receipt.json](controlled-failure.receipt.json)；其中 `backendObserved=false` 保持原样。实际后端确认写在独立的 [controlled-failure-reconciliation.safe.json](controlled-failure-reconciliation.safe.json)。

## 实际后端结果

| 核对项 | 本次实际结果 |
|---|---:|
| runner 尝试 / HTTP 500 | 20 / 20 |
| 初始未被 0.1 采样选中 | 17 |
| PostHog 完整失败 trace | 20 / 20 |
| span 物理行 / UUID / trace-span ID 对 | 80 / 80 / 80 |
| ERROR log 物理行 / UUID / error-span ID 对 | 40 / 40 / 40 |
| 缺失 trace / 物理重复 span / 物理重复 log | 0 / 0 / 0 |
| 有效 `mikka.trace.sample_rate` | 所有 span、log 均为 1 |
| `mikka.trace.retention` | 所有 span、log 均为 `error_or_slow` |

每条 trace 均有实际 root、其三个 PG 子 span，以及 root 和唯一失败 PG span 各自关联的一条 ERROR log。root 的 HTTP 状态为 500、span 状态为 ERROR、`critical=false`，保留固定安全字段 `trace_acceptance_failed` / `controlled_database_failure`；cause 链包含 PostgreSQL `22012`。PG ERROR span 本身的 code/type 属性为 null，仍按 null 保存；没有把 root 的 cause 移植成不存在的 PG 属性。

后端共执行 9 条限定查询。第一轮读取从 `02:46:29 UTC` 开始；实际 log severity 是小写 `error`，因此保留原先大写 `ERROR` 计数为 0 的原件，只将汇总表达式改为 `countIf(lower(severity_text) = 'error')`，没有改变范围或筛选条件。第二轮于 `02:48:37 UTC` 请求相同的四张规范表；两轮四张 `results` 字符串逐字一致。布尔原值 `True/False`、`false`、`1` 均保留，再按已观察到的闭集归一化。

实际详情分别为 80 和 40 行，均低于每页 500 行上限；与独立汇总数及本地实际 root/PG/error span ID 集完全一致。工具未返回显式截断标志，完整性据这些有限集合核验，不据 API 200 或虚构的 `truncated=false`。两轮稳定只描述这 20 条 case 的读回结果。

完整逐条结果见 [controlled-failure-reconciliation.safe.json](controlled-failure-reconciliation.safe.json)，规范行见 [backend-normalized-rows.safe.json](backend-normalized-rows.safe.json)，查询差异见 [query-contract-addendum.safe.json](query-contract-addendum.safe.json)。准备阶段文件里的 `backendObserved=false` / `backendValidationNotYetComplete=true` 是保留的历史状态，最终状态以独立 reconciliation 为准。

## 同源实际开销

同一 CI source、Node `v24.22.2`、Linux、真实 loopback HTTP/PG；每种条件先 warmup 100 次，再测量 600 次，每次三条 PG 查询。按 20 次一组顺序执行，交替 off/on 与 on/off；不是逐请求随机配对统计。

| 指标（ms） | tracing off | tracing on | on − off |
|---|---:|---:|---:|
| handler mean | 0.3718 | 0.7164 | +0.3446 |
| handler p50 | 0.3199 | 0.6462 | +0.3263 |
| handler p95 | 0.6043 | 1.0409 | +0.4366 |
| handler p99 | 1.1887 | 2.0854 | +0.8967 |
| HTTP round-trip mean | 0.6336 | 0.9802 | +0.3466 |
| HTTP round-trip p95 | 1.0960 | 1.5368 | +0.4408 |

这是在载入 PostHog token 前独立运行的 memory-exporter 基线，排除远程 PostHog 传输、模型和云电脑工作。artifact 只输出分布汇总，没有逐请求数组、置信区间或重复实验；不由此声明生产 SLO 达标。该进程另有自己的 20 次内存受控失败，不与随后实际 OTLP 导出的 20 个 trace ID 混算。原始数值及限制见 [overhead.receipt.json](overhead.receipt.json) 和 [overhead-verification.safe.json](overhead-verification.safe.json)。

## 收据完整性、清理与复核

最终 job log 仅下载一次；artifact `13645667123` 仅下载一次，实际 ZIP 3352 bytes，SHA-256 `382c8866b47780caa8872e816b0ff60a9e0de7e354b657943cc008a395540491`，与 GitHub metadata 相同，CRC 与路径/symlink 检查均通过。原始响应和 log 保留在 private 目录，公开索引只引用路径、bytes 和 SHA；签名下载 URL 未写入文件。

`Stop containers` 步骤成功。原 log 中 `02:43:12.5385577Z` 的 PG container 删除及 `02:43:13.7079095Z` 的 network 删除，均有成功返回；runner 同时报告 `cleanupComplete=true`。详见 [workflow-and-cleanup.safe.json](workflow-and-cleanup.safe.json)。本 owner 的下载进程已 exit 0，没有自建付费资源或仍运行的进程；已停止对此 run 的轮询、下载和 PostHog 查询，没有重跑或取消。

离线 [reconcile-controlled-failure.py](reconcile-controlled-failure.py) 直接核对保存的原始响应、精确 SQL echo、实际有限 ID 集、唯一行计数、错误与因果字段、两轮结果和 source hashes；实际运行 exit 0，见 [offline-reconciliation-run.safe.json](offline-reconciliation-run.safe.json)。最终文件清单与各原件 hash 见 [controlled-failure-final-index.safe.json](controlled-failure-final-index.safe.json)。

**结论边界：`backendObserved=true` 仅适用于本次精确 1d126 的 20 条 dev 受控失败。`finalFixSourceAcceptance=false`、`overallIssue1512Acceptance=false`、`productionModelCasePerformed=false`。后续合并版本仍需要绑定自身 source 的完整验收。**
