# #1211：18–19 UTC 项目生产观测补全

## 结果与范围

2026-11-04 **18:00:00–19:00:00 UTC**（右开区间）的项目观测已补足，采集状态为 collected，没有未满足项：

| 指标 | 结果 |
| --- | ---: |
| Vercel production function invocations | 4,077 |
| HTTP 5xx | 10 |
| Vercel CPU ms，route 分组加总 | 471,641.01096711936 |
| Vercel CPU ms，独立无分组项目总量 | 471,641.01096711925 |
| 历史 production deployments | 6 |
| 完整 route/status/deployment groups | 190 |
| Neon public_network_transfer_bytes | 60,516,203 bytes |
| 同一 provider 小时的 PostHog 快照 | 4 条，均为 60,516,203 bytes |

这是 **project-production observation**。它覆盖该小时全部生产 deployment 和并发活动；Neon 范围是项目所有分支。它没有绑定一个固定任务，也不是 before、after 或 idle 验收。productionAcceptance 仍为 false，不能用它计算某个 PR 的因果降幅或完成 #1211/#1212 的正文验收门槛。

## Vercel 截断如何补足

原查询恰好返回 100 个 summary groups、1,200 个 series rows，无法证明完整。原 [41895894978](https://github.com/alexj11324/Mikka/actions/runs/41895894978) 的 insufficient 结果和后续 [41902933896](https://github.com/alexj11324/Mikka/actions/runs/41902933896) 的响应结构诊断保留，没有改写为成功。

新采集器保持同一项目、团队、production filter 和完整一小时，在实际触及 100 组上限时：

1. 独立读取无分组 count 与 CPU 项目总量。
2. 枚举互不重叠的 deployment rollups（上限 16）。
3. 每个 deployment 独立按 route/status 查询，每片必须严格少于 100 组。
4. 逐片对齐 deployment rollup，再对齐项目总量；count 必须精确相等，CPU 仅容许浮点聚合误差（绝对 1e-7 ms 或相对 1e-9）。
5. 任何缺片、重复 deployment、越界、分片仍触顶或对账不符都继续返回 insufficient。

此次 6 片分别为 **23、25、37、63、22、20 组**，共 190 组。逐片请求数 **295、142、1,333、1,954、181、172**，精确合计 4,077，与独立项目总量一致。CPU 分组和与独立项目总量相差约 1.2e-10 ms。100 组完整性门槛没有放宽；before/after/idle 模式未改变。

采集实现 0feefc5c1b0e81eea1082b8e3152761be4975ea2；Docker 实际旧代码回归 RED 12/14，新代码 GREEN 14/14，零跳过；独立审阅通过。实际 Actions [41905292130](https://github.com/alexj11324/Mikka/actions/runs/41905292130) 成功，原始 artifact 13359359707（10,918 bytes），ZIP SHA-256：

eefca640b7c20351f3eedd86a7786f95a41d6116c29f655ca1564ccb34fb860f

report.json 与 summary.md 为该 artifact 原文，未补写其内容。采集时线上 alias/build 的上下文为 8a490000457b133a8b1434c5515d39277b7b586c，**不把采集时版本冒充 18–19 UTC 全小时的部署版本**。

## 请求分布

下表均是指定小时内 HTTP 200 的 route 聚合；完整所有状态及部署明细在 report.json。

| Route | 次数 |
| --- | ---: |
| /[locale] | 1,097 |
| /api/version | 398 |
| /v1/runs/[runId]/tool-approval | 290 |
| /api/approved-writes | 182 |
| /v1/devices/[deviceId]/heartbeat | 169 |
| /v1/devices/[deviceId]/repos | 169 |
| /v1/devices/[deviceId]/runs | 166 |
| /v1/devices/[deviceId]/commands | 107 |
| /v1/devices/[deviceId]/runs/[runId]/subscription | 107 |
| /api/pending-actions | 92 |

/[locale] 是路由分类，可能包含页面请求和 server actions；本报告不把 1,097 次全称为完整页面 SSR。函数观测聚合也不等于独立完整计费回执。

## PostHog 与 Neon 对时

独立 Neon 查询返回的 bucket 为 2026-11-04T18:00:00Z → 2026-11-04T19:00:00Z，reportedThrough=19:00 UTC，60,516,203 bytes。

只读 PostHog project 670821（Asia/Shanghai）查询 mikka_ops_snapshot 的明确 latest_hour_start/latest_hour_end 字段。19:00:21、19:15:21、19:30:23、19:45:21 UTC 捕获的四条事件都写明：

- start：2026-11-05T02:00:00+08:00 = 2026-11-04 18:00 UTC；
- end：2026-11-05T03:00:00+08:00 = 2026-11-04 19:00 UTC；
- latest_hour_bytes=60516203；
- production / provider，provider 与 collection healthy。

四条是同一小时桶的重复快照，**只计一次 60,516,203 bytes**。更早三条缺小时边界的事件不用于对时；20 点以后的 83,980,828-byte 快照明确属于 19–20 UTC，不混入本小时。原始窄字段结果、完整 SQL 和逐事件规范化记录分别保存在 posthog-hour-result.psv、posthog-hour-query.sql、posthog-hour-alignment.json。

## 剩余工作

关联页面读取 PR #1219 与 provider-hour 元数据 PR #1234；#1212 统一负责推送。本次只读采集没有应用部署、模型任务派发、生产数据库写入或预算/告警调整。按照会话明确要求，issue 正文的固定真实任务完整小时 before/after 及三路径验收仍待完成。API deepseek-flash 的余额阻断单独保留；Claude 和 Codex 订阅路径继续推进。
