# 附录：直接 daemon 完成原因枚举

在原 Web 只读取证完成后，root 明确扩展一次查询范围至同一个 run、trace、UTC 三分钟窗口内的 `mikka-daemon` 服务。仅执行了一条严格限定的 APM 查询；未读其他 run、未扩大时间窗口、未查询额外日志。

## 新的直接观察

| 字段 | 实测值 |
|---|---|
| runId | `2a4df252-7528-45ea-839e-6d1a42e1945d` |
| runIdHash | `a18972ad3b3fa09b` |
| traceId | `00000000000000000826C7A400942F4E` |
| spanId | `2522C49F42D6762C` |
| span name | `daemon.run` |
| service | `mikka-daemon` |
| service.version | `0.0.1` |
| harness | `codex` |
| 开始 | `2026-11-09T21:21:15.393000Z` |
| 结束 | `2026-11-09T21:21:27.488084Z` |
| **mikka.outcome** | **`blocked`** |

这条直接枚举把原 Web 证据中的“asked_human 或 blocked”收窄为 **blocked**。该完成分类现在来自实际 daemon span，不只来自 Web SQL 分支推断。

查询返回 12 个该 run 的精确匹配 span。本附录只保留 `daemon.run` 一条的必要安全列，另外 11 条不入包。准确参数及安全结果见 `daemon-outcome-appendix.json`。

## 保留的局限

- 仍不能据此断言具体调用了哪一个工具，也没有阻塞说明、问题内容或人类操作者信息。
- `service.version=0.0.1` 是 daemon 实际上报值，不将其当成源代码 commit 或官方 CLI 版本。
- 本附录不证明匿名 spare adoption、订阅 gate 成功或正式性能验收通过；原故障仍是 execution proof 未完成。
- 未修改原五个证据文件。原 `manifest.json` 已逐字另存为 `manifest.web-only.json`（1017 B，SHA-256 `888a2f236b4ad80a4e6989a0f13e450a67fd1faea166a5d15b546d83c4548184`）。新版 manifest 同时覆盖原文件与附录。

没有 PostHog 写入、源代码或 Git ref 修改，也没有新 VM、Task 或模型调用。
