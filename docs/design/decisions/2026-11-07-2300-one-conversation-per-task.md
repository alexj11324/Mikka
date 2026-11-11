# A task has one conversation; the hand is only on the task; 受阻 has its own icon

- Date: 2026-11-07
- Source: Alex, 2026-11-07, on the iOS build of [2230](2026-11-07-2230-one-icon-per-task-state.md):
  - on the two attempts in 活动, newest first, each opening its own thread: 「为什么这里第二次尝试会分给两个不同的 thread？你第二次尝试明显应该在第一次之后呀！」;
  - on the hand on the second attempt: 「举手符号是在待处理的时候，需要我去处理时才会用到……怎么会用到这个举手符号呢？」. He also said that a blocked item needs its own symbol, not the hand;
  - on the large title below the buttons: 「该放在最顶上，你放在左上角干嘛？」.
- Rule: R-52; `mobile.md` 「Where it lives」
- Superseded in part by: [2026-11-09-0045](2026-11-09-0045-no-attempt-word.md) (no 「尝试」 in the UI: a task is one conversation; only an Agent switch gets a divider)
- Superseded in part by: [2026-11-08-0120](2026-11-08-0120-ios-header-like-comma.md) (the phone's title row uses one centred native title).
- Replaces, in part: [2045](2026-11-07-2045-tasks-only-threads-inside.md):
  - rule 2's 「newest first」 order and its one-thread-per-attempt opening;
  - rule 5's 「an attempt pushes over the task」.
- Also replaces, in part, [2230](2026-11-07-2230-one-icon-per-task-state.md): 受阻 under the hand; the attempt icons.

## One conversation per task

- A task has one conversation, which joins all of its attempts. Opening the task's conversation, or any attempt in 活动, shows it from the oldest attempt to the newest. A divider between two attempts says how the earlier one ended and who took over, e.g. 「第 1 次尝试失败 · 换 Claude Code 再试」.
- Opening a specific attempt scrolls to its section. Opening the conversation itself starts at the newest message, like any chat.
- The header is ← and the task title, with the current Agent below it. The composer replies to the newest attempt.
- The first dispatch shows as one muted line (「Coordinator 派出了这个任务」), not as a blue bubble the person seems to have sent. Later attempts show only their divider.
- A failed attempt shows a plain cause, with its raw code under 详情 ([2026-11-05-0330](2026-11-05-0330-error-causes.md)).
- The backend is unchanged: each attempt is still its own run (R-81). The clients join the attempts from their run IDs.

**活动 is chronological**, oldest at the top, with the comment box at the bottom: 「Coordinator 创建了任务」 → 第 1 次尝试 → 第 2 次尝试. This is the order Linear and GitHub use for an item's timeline. LobeHub shows newest first, which is the order 2045 copied.

## Icons

**The hand is only on the task.** It appears on the task row, the chat task card, the task's status, and the window bar's count. It means the task needs the person: 等你回复, 等你确认, 待审阅.

**受阻 is its own task state, with its own icon**: an octagon (`OctagonAlert`; `exclamationmark.octagon` on iOS). It covers login, key, permission, quota used up and device offline. The task stays in 等待你 with the octagon, and the window bar's count leaves it out.

**An attempt never shows the hand.** It shows its own result:

| Attempt | Icon | Grey line |
| --- | --- | --- |
| running | ring | 运行中 |
| stopped to ask the person | pause (`CirclePause`; `pause.circle`) | 等你回复 / 等你确认 |
| finished | check (`CircleCheck`; `checkmark.circle`) | 完成, plus 「开了 PR #N」 when it opened one |
| failed | triangle | 失败 |
| blocked | octagon | 受阻 |
| replaced | no icon | 已替换 |

The task's own states are now eight: 等你处理 (hand), 受阻 (octagon), 失败 (triangle), 运行中 (ring), 排队中 (clock), and open or closed (the board's icons).

## The phone's title row

On every tab, the title sits in the top row, on the left, with the buttons on the right. It is not iOS's large title on a second row. 2045 already said this for the Bot tab; the build missed it.
