# Lists show tasks only; a thread is opened from inside its task

- Date: 2026-11-07
- Source: Alex, 2026-11-07, comparing Mikka's iOS 线程 | 任务 segment with LobeHub's task list: 「一个任务一般对应一个线程，为什么这里写两个线程和任务……LobeHub 也是用 task 做，它的 thread 似乎在里面，而不是并列」; then 「以后电脑和手机端都不应该再在这里显示 thread，全部应该只显示任务，想看 thread 的话，就必须进到任务里面去看」. He approved the phone sketch (「手机端我没意见」) and the desktop sketch (「电脑端也没问题」), and added four points for the Bot tab (below).
- Rule: `rules.md` R-50, R-52, R-82; `mobile.md` 「Where it lives」; `glossary.md` 「Rules for designs」
- Superseded in part by: [2026-11-09-0045](2026-11-09-0045-no-attempt-word.md) (no 「尝试」 in the UI: a task is one conversation; only an Agent switch gets a divider)
- Superseded in part by: [2026-11-08-0120](2026-11-08-0120-ios-header-like-comma.md) (mobile headers have one centred native title) and [2026-11-08-0200](2026-11-08-0200-mobile-spacing.md) (mobile task properties sit on the page without a box).
- Superseded in part by: [2300](2026-11-07-2300-one-conversation-per-task.md) (rule 2: one conversation per task, 活动 oldest first; rule 5: an attempt opens the task's conversation) and [2230](2026-11-07-2230-one-icon-per-task-state.md) (rules 3 and 4: the group is 等待你, and each row carries its own state's icon, not the group's)
- Replaces: the 线程 tab and 全部线程 as lists of threads ([2026-11-02-0310](2026-11-02-0310-all-threads-from-the-window-bar.md), R-50, R-52's thread groups, R-82's thread entry points); the iOS tab 线程 with its 线程 | 任务 segment and the tab 对话 ([2026-11-06-1300](2026-11-06-1300-ios-comma-tabs-accepted.md)); the thread bubble icon in lists ([2026-11-04-2220](2026-11-04-2220-task-circle-thread-bubble.md)); the workspace menu in the iOS 对话 bar

Every dispatch is already a task ([2026-11-03-0415](2026-11-03-0415-all-dispatch-through-factory.md)) and a task has one thread at a time (R-81), so a thread is the task's work, not a second thing to list. LobeHub and Warp Factories both put the task on top and its runs inside it.

## The rule

1. **No list shows threads.** On the web and the phone, every list is a list of tasks: the right panel's tab (详情 / **任务** / PR / 电脑), the window bar's list (**全部任务**), the phone's **任务** tab and search results. A search hit inside a thread's conversation shows as its task.
2. **A thread is opened only from inside its task.** The task's detail shows, top to bottom: its number, its title, its properties in one grey box (status, priority, the dispatching bot, Agent and model, where it runs, schedule), its description, then **活动**. 活动 lists each attempt (「第 2 次尝试 · 待审阅 · date」, newest first), a replaced thread, and events such as 「Coordinator 创建了任务」. Opening an attempt shows that thread's conversation; its header leads with ← back to the task and names the task under the attempt. A failed attempt says 失败 in 活动; its raw error code is inside the attempt, under 详情 ([2026-11-05-0330](2026-11-05-0330-error-causes.md) still holds).
3. **Task groups.** A task list groups its rows **等待你 · 进行中 · 待办 · 已完成** (first written 待处理; renamed by [2230](2026-11-07-2230-one-icon-per-task-state.md)). 等待你 is everything waiting on the person: a question, a PR to review, a blocked or failed attempt (R-52's 等待你 and 受阻). 进行中 is an attempt that is queued or running. 待办 is an open task with no running attempt (R-52's 空闲, and tasks not yet dispatched). 已完成 (done or cancelled) is collapsed. R-52's outcome judgement still decides which group a task's current thread puts it in.
4. **Icons, no dots.** Each row carries its own state's icon, as listed in [2230](2026-11-07-2230-one-icon-per-task-state.md); the raised hand is only for 等你处理. (First written as one icon per group, which put the hand on every row.) No icon carries a coloured corner dot, and rows carry no status dots (the phone's no-badges rule, 2026-11-06, now covers the web too). The window bar's button shows the hand and the count of tasks waiting on the person.
5. **Where a task opens.** From a chat's task card or the right panel's list, the task's detail opens in the right column beside the chat, and its attempts open in the same column. From 看板 or a link, the task opens as its own page in the centre (R-82). On the phone the task pushes over the 任务 tab, and an attempt pushes over the task.
6. **Chat cards are task cards.** A dispatch in a chat shows the task (status icon, number, title, and one grey line: state · dispatching bot · time). It opens the task, never a thread directly. A push about a waiting thread opens its task.

## The phone's Bot tab

Alex, 2026-11-07, on the current iOS 对话 tab:

- The first tab is **Bot**, with a bot icon, not 对话.
- The large title sits in the top bar's own row, with the buttons on the right, as on the 任务 tab; no second 「Bot」 label under it.
- No workspace menu in the bar. Switching workspaces happens only in 设置 › 工作区.
- The top-right button is **+** (新建 Bot, 新建群聊). The 任务 tab's new-task button is a + as well.

The tab bar is **Bot · 任务 · 建议 · 设置**, plus the search tab.

## Sketch, not spec

Figma `zPe5LKycb2XuT1ivCLRw07`, page 1085:2 「只显示任务，线程在任务里」: M0–M3 (phone) and D1–D3 (desktop), light and dark. Alex: 「这个只是草图……你只要记住这个样子就行了」. The frames fix the structure above. They are not a visual spec: build the web with the hosted UI's real BoardUI / affectUI components and the phone with its native components and tokens, not by copying the sketch's spacing, colours or icons.
