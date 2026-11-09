# R7 42695935772 / A1：Codex 停止路径只读取证

## 结论

该次失败经过 daemon 完成请求与 Factory 问题交接路径。将真实 Web SQL span 与固定 12458 源码对照，可以把完成原因收窄为 `asked_human` 或 `blocked`；不能进一步确定具体枚举、工具名、提问内容或人类操作者。

这次失败仍是 `template_gate_execution_failed / startup_ended_before_execution_proof`。它不能等同于前一轮的 `template_gate_bootstrap_adoption_missing`，也不能算订阅门槛或正式性能验收通过。

## 直接观察

查询仅使用现有已授权 PostHog connector 的只读能力：project 670821、service `mikka-web`、2026-11-09 21:19:00–21:22:00 UTC、run `2a4df252-7528-45ea-839e-6d1a42e1945d`。没有读取生产数据库、秘密值、Actions 原件或新的模型/Task。

- completion 路径返回 71 个精确匹配 span，`service.version=12458fe22e12`；只保留 7 个支持结论的安全 span。
- `POST /v1/runs/[runId]/complete`：21:21:28.027000–21:21:28.299138 UTC，HTTP 204，`mikka.client_kind=daemon`。
- trace：`00000000000000000826C7A400942F4E`；completion span：`D3CB89AEE2A38CCE`。
- 同一 completion span 的子查询执行 `SAVEPOINT completion_question_record`，随后 `INSERT INTO factory_questions` 返回 1 行；insert span `7F57A15DEB8DC8BC`，21:21:28.248000–21:21:28.250832 UTC。
- 对应 RELEASE 和后续 COMMIT 均存在，该 completion 查询结果中没有 ROLLBACK。
- 精确 run 的 Web 日志计数为 109。读取最新 100 条（21:21:19.046899–21:21:32.801656 UTC），没有 stop/actor/handoff/outcome 属性；未声称检查过全部 109 条。
- 对同一 run 全窗口做 `mikka.rpc.action` 值查询，仅返回 `coordinator.sendCoordinatorMessage`，4 条。RPC 日志缺席不能证明某行为绝对未发生。

## 从固定源码得出的推断

1. `lib/run-completion-effects.ts` 的完整 `settleRunCompletionEffects` 函数仅在 `stopReason` 为 `asked_human` 或 `blocked`、且不是 repositorySelection 时进入 `completion_question_record`。所以观察到该分支意味着这次完成并非普通 `turn_ended`。
2. `lib/factory/questions/store.ts` 的完整 `questions.record` 方法在插入前要求：run.status=`stopped`、stopReason 属于上述二者、sessionId 存在、`stopRequestedAt` 为空。真实插入成功且事务提交，因此可推断这几个守卫在该时刻通过。这里没有读取数据库字段值，结论来自执行分支与固定源码的组合。
3. `completionTransaction` 只在首次有效完成时写终态并调用上述 effects；已终结的重放不走该问题插入分支。
4. 上述事实支持“daemon 提交求助/阻塞交接”这一原因类别，没有支持“外部 stop 请求抢先终止”这一解释。它不能识别人类或系统操作者，也不能区分 `request_help`、`ask_human`、`report_blocked`。

全部相关文件已对照固定 Git 对象逐字核验；完整函数与文件 blob/校验和见本目录两个 fixed-source 文件。

## 证据边界

- 查询到的 Web completion spans 没有 stopReason 值或 handoff 工具名。SQL 中只有模板和占位符，没有参数值。
- 未查询 `mikka-daemon`；其 `daemon.run` span 可有 `mikka.outcome`，但不在本次授权指定的 service 范围内。
- `stopRequestedAt` 为空仅指成功问题记录守卫通过的时刻；不是对所有并发或历史请求的全局证明。
- 本次只读取证不证明官方 0.167 匿名 spare adoption，也不改变任何发布门槛。
- 12458 源码不包含后来 #1506 / PR #1836 的改动；该后来批次不能解释本次已发生失败。源码和遥测因果必须分开。

## 最小失败投影建议（尚未实现）

仅扩展现有 acceptance 观察的安全摘要，不增加网络、SQL、轮询或普通 Task 字段，不修改成功条件：

- `terminalRunState.stopReason`：从已经读取的 `data-run-state` chunk 提取现有受限枚举；daemon 的 `setState` 已输出此字段。保存最后一个合法终态原因，缺失则 unknown。
- `handoffKind`：从已经识别的四种 handoff 工具名映射到固定枚举 submit/request_help/ask_human/report_blocked；只记录枚举和成功布尔，不记录参数/输出。
- `successfulExecutionTool`：保留 `observeChunks` 已计算的排除 handoff 后的成功执行工具集合是否非空。现有 `successfulTool` 只代表某个 tool output 成功，也可能是 handoff。
- 可选记录已有 `thread.question`（waiting/resuming/null）和监测期间曾见 `thread.stopping` 布尔。后者不能当作终态 stopRequestedAt。

不新增 actor 标识、自由文本、问题内容、prompt、reply、工具参数或凭据。不修改已经冻结的 PR #1842 或 batch 源。
