# 任务完整链路阻断检查

检查日期：2026-11-02（America/New_York）。仓库：Mikka，分支 `work`，基线 `2166bd1396868dc8e6ea9a643f9aecd6d920cc09`。修复保留在工作区，未部署。

检查范围：Coordinator prompt 与工具契约、任务仓库解析和派发、任务线程续做、云端机器准备与生命周期、daemon 领取和执行、MCP 提交、校验与交付、服务端完成事务、完成事件回到原 Bot。只修复有具体触发路径的功能阻断。

## 已复现并修复

| 问题 | 触发与后果 | 修复 | 发生可能性 × 影响（各 1–10） |
| --- | --- | --- | --- |
| 长正文吞掉本次要求 | `runPrompt` 将整个字符串截为 100,000 字符。正文足够长时，后面的本次补充、交付规则和 standing instructions 全部消失，续跑拿不到新要求。 | 先为补充要求和执行指令预留空间，再缩短正文并标记截断；短 prompt 保持原格式。 | 3 × 8 = 24 |
| 提交工具和交付指令冲突 | GitHub 运行指令要求 Agent 自己 commit、push、创建 PR 并等待检查通过，`submit` 工具却要求不要 commit/push，声称 Mikka 会代办。后者会诱导提前交接，缺少已完成交付的凭据。 | 工具明确遵守该 run 的交付规则；提交回执不再承诺代为提交和推送。 | 7 × 9 = 63 |
| 只读调查被当成代码实现校验 | 已完成的只读调查仍执行仓库 verify，构建需要写文件或命令失败时被 daemon 判成失败；没有 verify 时被判为 stopped。服务端已有只读报告成功语义，两个状态源不一致。 | 普通只读任务直接提交报告，verify 如实记录 `not_run`；acceptance 和 benchmark 仍执行原有校验。 | 8 × 7 = 56 |
| 云端生命周期启动失败遗留活动任务 | 创建任务机器后立刻清空 `queuedRunId`，随后 Workflow `start()` 抛错时，catch 无法结束已排队的 run。本地回退会被活动任务挡住，后续消息可能继续发给无人执行的 run。 | 机器准备与生命周期启动都成功后才清空待清理 ID；失败先走现有结束流程，再返回不可用。 | 4 × 9 = 36 |
| 云端线程输入框无法续做 | 第一轮派发会把 run 的仓库迁到任务专属机器。输入框续跑却把这个仓库 ID 直接交给只接受 Bot 电脑仓库的 `queueCloudRun`，稳定返回 `Bot computer task is unavailable`；该入口也没有准备机器和启动生命周期。 | 复用现有云端派发入口重新解析源仓库、准备任务机器并启动生命周期，保留模型、订阅或 key 身份、只读限制和原结果目标。 | 10 × 9 = 90 |

## 回归证据

修复前：

- `lib/run-prompt.test.ts`：长正文导致 `brief.includes(note)` 断言失败。
- `packages/daemon/test/agents.test.ts`：真实 stdio MCP 工具列表暴露旧的交付说明，与 run 的指令冲突。
- `packages/daemon/test/runs.test.ts`：只读调查提交后不是 `succeeded`，实际运行了不应执行的 verify。
- `tests/cloud-dispatch-startup.test.ts`：恢复原清理顺序后，生命周期失败的实际调用序列缺少 `end`。
- `tests/cloud-runtime-auto.db.test.ts`：真实 PostgreSQL、真实派发和任务机器记录下，线程输入框续做报 409 `Bot computer task is unavailable`。

新增测试同时覆盖普通云端线程、只读云端线程、MCP 原结果目标、模型和订阅保持，以及服务端只读报告不需要 publication 的完成事务。云端数据库测试只替换 E2B 提供商调用和 Workflow 调度，应用数据库逻辑不替换。

验证运行和限制在下方补充。所有本地数据库目标均为 `127.0.0.1:5432` 上隔离的 `*_e2e`；未使用生产数据。未执行浏览器测试。
