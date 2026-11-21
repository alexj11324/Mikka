# 任务状态由工作区自定义；Needs you / Waiting 是运行态

2026-11-19。Alex 要求状态模型「和 Capy 保持做法一致」。

## Capy 怎么做（0.9.2 源码）

`features/settings/issue-states-page.tsx`、`issue-state-editor.tsx`：状态由组织自定义，有名称、图标、颜色、类型 open / closed，每类一个默认值；删除状态时必须把它下面的 issue 迁到别的状态（MoveAndDelete）。Needs you、Waiting 不是 issue 状态，是线程的运行态。

## 决定

- 新表 `workspace_issue_states`，每个工作区回填 7 个内置状态（backlog / todo / doing / review / done / canceled / duplicate），任务改用 `state_id`。
- **Needs you** = 等人处理（提问、审批、审 PR）；**Waiting** = 等外部（CI、设备上线、额度、被别的任务挡住）。两者继续由 `lib/task-state.ts` 从运行事实推算，显示在行上，不进状态表。工作区想要手动的同名状态，可以自己新建。
- 自动推进按状态的类别落到该类默认状态。
