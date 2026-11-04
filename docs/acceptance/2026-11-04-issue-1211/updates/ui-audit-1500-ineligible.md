# 2026-11-04 15:00 UTC 审计窗口作废与取消记录

**结论：15:00–16:00 不是有效的一小时基线，不计为 #1211 或 #1212 生产验收通过。**

生产 build 固定为 `bff53413d9d64a48618010dfe4611024251e5293`，deployment `dpl_4kZ7pUMoULur1GKEUhcBqVqmhH2J`。正常 Owner UI 仅发送一次合同；新任务为 ALEX-40，issue `9cd1c842-c316-4426-a080-b05f4b26812d`，Factory task `a17cc866-715a-4820-8208-aea2c860e9b2`。

## 为什么作废

首轮调度包装选择了 `dispatch_bot_computer`，没有显式指定仓库。它进入空的 Bot 工作树：HEAD `6c0e6d91a0a4a69ea973503472e38567c586a7d9`，冻结源 `2a0e398762d35a94ac673d04ce3683d9de1568d7` 不存在。Agent 通过产品正常的 `switch_repository` 请求转到 `alexj11324/Mikka`；没有第二次 Owner 派发。

自动后继在 **15:00:13.962 UTC** 才开始。整点样本已看到首 run 停止，后继尚未开始，因此不能将准备、排队或部分运行算作完整小时。后继随后真实核到了生产 HEAD、冻结源存在以及 297 个目标文件，但这只证明仓库准备，未形成审计报告或测试通过。

这是调度准备中的具体失误：误把“不传仓库”当作避免发布的办法。源码实际上提供 `dispatch_run` 的显式 `repo` 与 `readOnly:true`。下一轮应先核实际 tool receipt 与冻结策略，不能再把空工作树的启动当作审计已经开始。

## 真实终态与清理

| 项目 | 实际结果 |
| --- | --- |
| 首 run `cc7403af-24e5-4295-8aac-6538a5502e89` | 14:57:50.893 开始，14:59:07.244 以 `stopped / blocked` 结束 |
| 后继 `277d9758-1ece-4434-88ff-0fd6a8fba4f1` | 15:00:13.962 开始，Owner 停止请求 15:02:06.016，15:02:07.822 以 `failed` 结束；错误为 `child_exit: cli_exited_early` |
| Factory | 15:02:23.776 查询为 `execute / cancelled`，revision 6，activeRuns 0 |
| 两个任务 VM | 15:07:20.730 查询均 `paused`，worker lease 无 |
| 模型与凭证 | 两 run 均 `gpt-6-luna`、显式选择、官方 Codex 原订阅 revision 2、`codex_cli`；API claim 0 |
| 发布 | 首 run 无 publication row；后继有 admission/publication row 1，但 pull request row 0；没有 push/PR 工具调用 |
| 人工操作 | 一次发送、一次正常 UI 停止；没有 Owner retry、重复 dispatch 或生产 SQL 写入 |

后继因停止表现为 `failed`，没有将它改写成“stopped”。机器状态为应用数据库观测，未当作独立 E2B provider 回执。

## 合同及设置指纹

冻结 `run.prompt` 中的 host handoff goal 保留了原始固定工作定义。只将该字段的 literal `\\n` 行分隔还原为 LF 后，全文 1988 UTF-8 字节与准备稿逐字节相等，SHA-256 均为 `2c7e19c75a16d111cbf226eefcfcc0a826cddf85c995dc3f5b17a0b88824a203`。此值是本次具体 prompt 的 hash，不是 workloadDigest。issue 正文转写遗漏了末段的提前结束/额度暂停说明，已单独记录；没有改 issue、epoch 或补发来掩盖差异。

恢复临时模型排序前，完整 settings / entries / choices 仍严格匹配操作后指纹 `be61fe728f63ec796c7fc79d97107e8b625a9feb52355eb407cbef2e26462c31`。正常 UI 仅移除新增条目 `12e7fead-96d4-48b3-995e-bbab97afc8ed`，于 15:09:15.020892 保存。原四条 ID、配置、顺序和五个 chat choice 全部保留；比较仅排除正常保存重写的两个时间字段。恢复完整快照 SHA-256 为 `c37a4c477db350af107f603619b98dda88b0e8751b8212991c9af9137c284228`。

新审计 Bot 的显式 Luna chat 绑定保留。没有猜测恢复原 390 设置，没有更改共享 token 或生产 Neon 配置。

## 保留的证据与剩余工作

详细字段见 [JSON 记录](ui-audit-1500-ineligible.json)。[整点 Neon 样本](20261104T1500Z/neon-samples.json)、[两次公开 build 观测](20261104T1500Z/versions.raw.json) 和 [原始窗口判定](20261104T1500Z/window-status.json) 原样保留。这些只用于诊断，不补成完整小时，不据此计算节省率。

还需要新的完整 before 窗口、相关 PR 的生产部署及真实 after 窗口，以及同一时间桶的 Vercel / Neon / PostHog 证据。旧的 15:00 合同不会重发。
