# 受阻 is a board column, not a task status

- Date: 2026-11-06
- Source: Alex, about the task board: 「我们现在的看板里面缺少一个 block 的 category，导致我在看板里面看不到这些被 block 的 issue 卡片。」 He asked for the leading products' approach without a further design review.
- Rule: —
- Superseded in part by: [2026-11-13-1405](2026-11-13-1405-one-task-status.md) (what a run says no longer moves a task into 受阻; the column holds flagged tasks and tasks a dependency holds back).
- Replaces: —

Why the cards were missing: a task's column was its status alone. ALEX-2 stayed
`todo` while its newest thread failed, so the thread list showed 受阻 and the
board showed the card in 待办 with a small 受阻 badge (and only when 线程状态 is
shown). The iOS 任务 list had no mark at all. No filter hid it.

What leading products do: Linear has no built-in Blocked status; it marks an
issue blocked by a "blocked by" relation and teams add a custom Blocked state
if they want a column. Jira teams either add a Blocked status or set the
"Flagged" impediment, which sits beside the status. GitHub Projects has only a
single-select Status field. A status cannot move back on its own, so a status
only fits when a person moves every card by hand.

Decided:

- 受阻 is a group the task falls into, worked out from its newest thread, its
  "blocked by" tasks and the person's flag (`lib/task-blocked.ts`). The task
  keeps its own status. When the thread resumes, the blocker closes or the
  flag is cleared, the card is back in its own column because its status never
  moved.
- It blocks when: its newest thread asks a question (等你回答), ran out of
  quota (额度用完), was judged blocked (运行受阻) or failed (运行失败); a task it
  is blocked by is open (等 MIK-12); or the person flagged it (已标记). A closed
  task is never blocked. A PR waiting for review does not block.
- A person moves a card into 受阻 by dragging it there or with 标记为受阻; this
  sets the task's `block` flag. Moving it out (drag to a column, or 移出受阻)
  sets the new status and sets aside what its newest thread said, until a newer
  thread runs.
- The board shows 受阻 after 进行中 (Linear's custom Blocked sits in Started).
  Each card names its reason. The list view groups it the same way, and the
  状态 filter has 受阻. On iOS, 受阻 is the first section of 任务, each row with
  its reason. The desktop app shows the web board.
- No status value, no migration, no Linear mapping change: the flag lives in
  the task's metadata, beside `blockedByIds`.
