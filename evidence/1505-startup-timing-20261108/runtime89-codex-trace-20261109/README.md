# 89 Codex 既有追踪闭式证据

本目录仅归档已完成的 PostHog 只读查询；未新增模型、生产业务请求、数据库查询或发布动作。原订阅 gate FAIL 保留，未产生新的正式六例样本。

## 固定原件

- 文件：`closed-projection.json`
- UTF-8 字节数：31,262
- SHA-256：`8d7fba7dbda3a59a162e37727a032f79c93f5e7efc8c502ec7f1fe2792666481`
- 数据范围：Mikka / PostHog US project 670821，2026-11-09 07:51:40–07:54:20 UTC。
- 本次共 10 次项目数据读取，包含项目、service 与属性发现；不含技能、工具 schema、文档及仓库源码读取。归档没有再次查询 PostHog。
- 记录对象：trace `0000000000000000137a8de31ae75357`；run `bcd5de6f-244c-482a-9409-fd09bca4a6ef`；task `ed029a48-f08d-4f27-912b-70dda9c7da93`。
- [实际工具返回的 trace 链接](https://us.posthog.com/project/670821/tracing?trace=0000000000000000137a8de31ae75357)。

## 身份与解释边界

**Candidate 身份尚未最终绑定。** 查询所见 harness、时段和 web `service.version=89eae89e9e79` 与调查目标相符，但外部唯一工件 reader 尚未给出可对照的 candidate run ID。本目录不能单独证明该 trace 就是 R42579094044/attempt1 的 CX case。Daemon 只导出版本 `0.0.1`，未观测到 W。

**跨主机时钟未校准。** 各 span 保留原始时间和原始 duration；不得将不同主机绝对时间差解释成 RTT、串行耗时或因果顺序。同 trace 的新 Workflow 409 与 daemon 完成的相对显示位置不能独立确立根因。

客户端 events/checkpoint HTTP 200 证明观察到成功响应，不证明具体 reply 已发出、入库或通过验收匹配。现有字段未提供逐 chunk 类型、序号或回复字节数。Generation collector 的截断、fallback 与 rejected-batch 计数是另一观测层，不能据此推翻已由 owner 报告的 runtimeEvidence/adoption 通过。

限定窗口 trace 请求返回 701 个 span 且无后续分页，但这不证明 exporter 完整无丢失。保留全部已发现错误和采集缺口，不推断 quota、凭据、模型或网络根因。

## 保存范围

本目录保存原样闭式投影和此说明。投影仅含关联 ID、状态、计数、时间、固定来源与解释局限；不含模型正文、prompt、SQL 文本、原始 HTTP URL、凭据、原订阅日志或工件。查询原返回保留在当次会话，不在本目录冒充完整 raw APM 导出。
