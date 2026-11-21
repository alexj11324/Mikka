# 自动化：GitHub 事件触发

Alex，2026-11-15：自动化按 Capy 的 Automations 补齐，第一步是 GitHub 事件触发。延续 [2026-11-15-1337](2026-11-15-1337-automations-v1.md)：执行内容仍是 `dispatch_task`，以创建者身份运行，每次触发都重新检查。

## 决定

**触发条件**

- 一个自动化的「满足任一条件就运行」除了定时和手动运行，还可以有最多 20 个 GitHub 事件触发（定义里的 `events`）。只能用于 `dispatch_task`。
- 事件只取 GitHub App 已订阅的：PR 打开、草稿 PR 打开、PR 有新提交、PR 合并、PR 关闭未合并、标签变化、Issue 打开、评论（Issue 或 PR）、review 提交、review 行内评论、检查完成、检查失败。`push` 和 `workflow_run` 需要在 GitHub App 设置里加订阅，这一步不做。
- 每个事件触发必须写明仓库（1 到 20 个），可选分支和标签过滤，还可以写一句「什么时候才跑」，在运行前用现有的 Decision 模型判断；不符合就记一次「跳过」，不派发任务。
- 来自 bot 账号的事件不触发（`sender.type` 为 `Bot`），避免自动化改了 PR 又触发自己。

**授权**

- 创建、修改、恢复时，事件触发里的每个仓库都要在这个工作区里可用（有成员安装了它）；收到事件时再查一次。查不过的事件不创建运行。
- 运行仍走 `dispatch_task` 的检查：创建者是 active 成员，Bot、机器、Agent 配置可用。
- 事件内容（标题、作者、链接）作为外部数据交给 Bot，标明不是创建者的指令。

**幂等和并发**

- 一次运行以「自动化 + GitHub delivery ID + 触发序号」为操作 ID，GitHub 重发同一事件不会多建任务。
- 达到「最多同时运行」时，这次事件记为「跳过」并写明原因，不排队。

**不在这一步**：每日次数上限和用量（下一步）、线程模式、专属 webhook 地址、Slack 和 Linear 触发。

实现：`docs/backend/179-conversation-schedules.md` § Event triggers。
