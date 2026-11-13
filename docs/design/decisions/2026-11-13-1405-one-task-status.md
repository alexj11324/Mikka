# A task has one status, one entry, and a conversation has its own short title

- Date: 2026-11-13
- Source: Alex, 2026-11-13, on the official build showing a task's status field beside a second set of run states (排队中 / 运行中 / 等待你 / 等你回复 / 待审阅 / 失败) and a 任务 page beside the board: 「这就不应该有两个状态，只能有一个状态」, 「看板就是放任务的地方」, 「按照 linear 的写法去写」. On names, the same day: 「我改的永远都是对话，也就是 session run、agent run，这个必须要用短标题」 and 「这是绝对不行的，对话必须要有自己的标题」. On scope of the change: 「你要改就改，所有东西都是可以改的，包括数据库之类的」.
- Rule: R-15, R-52, R-53; `glossary.md` (Task status, Agent mark, Run result); `components.md` (Board, task status icon); `../ui-overlay.md` (the `tasks` slot is retired)
- Replaces:
  - [2026-11-10-0659](2026-11-10-0659-task-code-chips-and-work-area-tabs.md), the clause 「The state beside a task is the task's own state (`localTaskState`, R-52) on every surface」. The state beside a task is its status field. The rest of 0659 stands (the chip is an icon and the code, a thread is a link, work opens in work-area tabs).
  - [2026-11-07-2230](2026-11-07-2230-one-icon-per-task-state.md) and [2026-11-07-2045](2026-11-07-2045-tasks-only-threads-inside.md), the groups 等待你 · 进行中 · 待办 · 已完成 on task lists and a task row's run-state icon. The hand, triangle and ring are now the Agent mark beside the status, and an attempt's own result icons stay.
  - [2026-11-08-0130](2026-11-08-0130-task-state-icon-colours.md), for the web's task rows: the status icon takes the status's colour (R-34); the run states' colours move to the Agent mark. The iOS app is not changed by this decision.
  - [2026-11-06-1600](2026-11-06-1600-blocked-board-column.md), in part: a question, quota, a blocked or a failed run no longer moves a task into 受阻. 受阻 holds a task the person flagged or one a dependency holds back.
  - The board's default filter 「负责人：我」 and its 全部 / 工作区 / 个人 segment (Figma 77:2), with the lock on a personal task's card.
  - The 任务 page (`?section=tasks`, [2026-11-09-2330](2026-11-09-2330-overview-as-work-area-tab.md)'s 「看板 is a view of 任务」): the board is the entry.
  - [2026-11-10-0659](2026-11-10-0659-task-code-chips-and-work-area-tabs.md), 「A thread … is its title … The title is the task's title without its code」: a thread is named by the conversation's own short title.
- Unchanged: [2026-11-10-1341](2026-11-10-1341-sidebar-short-title-limits.md). A task's title is whatever the person or the model wrote, with no limit, and the task detail keeps the full title.

## One status

The model is Linear's: an issue has one state, and what an agent is doing is beside it, not a second state. Capy 0.7.2 does the same (issues carry one `status` / `stateId`; threads are separate objects with their own `statuses`).

- A task's status is its status field: 待整理, 待办, 进行中, 评审中, 已完成, 已取消, 重复. Every surface shows that status with the same icon and the same word: the board's columns and cards, task rows, the chat's task chip and its hover card, the dispatch card, the bot sidebar, the task page and the work-area tab.
- What the task's Agent is doing is the **Agent mark**, a small icon after the status icon: working (a turning ring), waiting for the person (the hand), error (a triangle). Its words (Agent 运行中, 等你处理, Agent 出错) are a tooltip and an accessible name. It is never a status, a group, a column or a filter on status. A task with no run under way, waiting or failed has no mark.
- What needs the person stays in 收件箱, as before. No status word is added for it.
- 受阻 remains a column and not a status: a task the person flagged, or one blocked by an open task. What a run says (a question, quota, a failed run) is the Agent mark on the card in the task's own column.
- A run keeps its own result where a run is shown (活动 rows, a run with no task): glossary, Run result.

## The status icons

| Status | Icon | Colour (R-34) |
| --- | --- | --- |
| 待整理 | dashed circle (lucide `CircleDashed`) | grey |
| 待办 | circle (lucide `Circle`) | grey |
| 进行中 | ring with a hand at twelve | warning |
| 评审中 | ring around a check | info |
| 已完成 | filled disc with the check cut out | success |
| 已取消 / 重复 | lucide `CircleX` / `CircleSlash2` | grey |

进行中, 评审中 and 已完成 are Orca's ConductorProgress, ConductorReview and ConductorDone shapes ([stablyai/orca](https://github.com/stablyai/orca) at `b18029ef`, MIT, © 2026 Lovecast Inc.; notice in `NOTICE`), drawn in `components/workspace/status-icons.tsx`. 待整理 and 待办 already matched Orca's defaults. Orca fills the ring with its page colour; ours leaves it open so it sits on any surface, and the check in 已完成 is cut in `--status-icon-surface` (the page background by default). Orca colours review green and done a muted tan; we keep R-34's colours so a status reads the same in its icon, its menu and its badge. The 受阻 column keeps its own icon ([2026-11-07-2300](2026-11-07-2300-one-conversation-per-task.md)).

The official board's column heads and its card status line are affectUI's Kanban glyphs, which the block does not take as data; they stay as shipped ([2026-11-09-0050](2026-11-09-0050-paid-blocks-as-shipped.md)).

## One entry

- Tasks are on the board. It has two views, 看板 and 列表. The navigation has one item for it, and an old `?section=tasks` link opens the board in its list view.
- The board shows every task of its workspace. There is no default filter; a filter is the person's choice. A stored copy of the old default is dropped, and any other saved filter is kept.
- The board has no 全部 / 工作区 / 个人 segment and a card no 归属 lock. All of a workspace's tasks are on its board; personal work lives in the personal workspace.
- A bot's own page still lists the tasks it dispatched. It is a filtered view of the same tasks: rows sit under their status in the board's order, with the status icon and the Agent mark.

## The status advances with the work

As Linear moves an issue when its branch and PR move:

| Event | Status |
| --- | --- |
| The task's Agent starts a run | 进行中 |
| A run is submitted for review, or delivers its PR | 评审中 |
| The last open PR Mikka delivered on the task is merged; or the Factory accepts or merges it | 已完成 |

One rule for every move (`lib/task-status-advance.ts`): forward only along 待整理 → 待办 → 进行中 → 评审中 → 已完成; 已取消 and 重复 never move; a status the person set after the work was asked for is kept; a repeated event changes nothing; each move is a versioned system change, so a person's change can be told from an automatic one.

## Conversations are named by a short title

- A conversation (a thread: a run and the runs that continue it; a session run, an agent run, a subagent run) is always named by one bounded short title, the same on every surface that names it: the thread link in a reply and its hover card, the dispatch card, thread rows, the thread header, a waiting row in 收件箱. The bound is [1341](2026-11-10-1341-sidebar-short-title-limits.md)'s: 12 CJK characters, or 6 words and 60 characters.
- The title is the conversation's own: its stored title; until it has one, the bounded first line of what it was asked; and only when that is empty, its task's short title. A conversation never borrows its task's full title.
- Task titles are not restricted or rewritten by this.
- In a reply, a task's chip directly followed by its own thread (nothing but spaces between) is one reference: the chip (status icon and code), one word gap, then the thread's short title as a link. Each keeps its own click target, and they are never two pills. When that thread's dispatch card sits right under the reply, the inline thread title is left out and the chip stays.

### The stored title

A conversation owns its title, as Capy's threads do (`PATCH …/jams/:id` rename, `POST …/regenerate-title`, `titleTriggers: pull_opened | first_run_ended`).

- **Storage.** `agent_runs.title` (60 characters, the task short title's check) and `agent_runs.titleSource` (`generated` or `manual`). A thread is a run and the runs that continue it ([2343](2026-11-10-2343-thread-attempt-is-a-run-in-a-chain.md)); chains have no row of their own, so every run of the chain carries the same title and a write covers the whole chain. No backfill: an older conversation keeps the bounded fallback.
- **Generation.** The small model that writes a task's short title writes this one too, through the same call, admission, prompt, parsing and limits (`generateShortTitle`, `lib/short-title-server.ts`). It runs after the response as a background job, never on a render path and never blocking a run; a failure leaves the fallback. It reads only the recorded task range of the prompt, never the execution instructions around it.
- **Triggers** (`lib/conversation-title.ts`):
  - created: named from what it was asked. A run that continues a conversation takes that conversation's title without a model call.
  - first run ended, and PR opened: named again from what it did and the PR's title, only while the title is a generated one.
- **A person's rename wins.** `renameConversation` holds the typed title to the same bound, writes it on every run of the conversation and marks it `manual`; no trigger replaces it, and a rename that lands while the model is answering is kept. `regenerateConversationTitle` is the person asking for a generated title again, so it is the one path that replaces a manual one.
- **The fallback** never ends inside a word: a Latin word or a number that does not fit is left out whole.
- **Where it is read.** Thread links and their hover cards, thread rows, the thread header, waiting rows in 收件箱, the dispatch card, and the run list's name that desktop notifications use.

Not built:

- No rename or regenerate control on screen. The thread header (`components/slots/thread-header-contract.ts`) has no menu to put them in; the two server actions exist and are tested.
- A configurable title prompt and triggers per workspace and person, with audit events.
- The iOS app.

## Left for a follow-up

- Server-side `issues.scope` (`workspace | personal`) still decides who can see a task and whether it syncs to Linear, and the task page keeps its 归属 row because it is the only control over that. Whether every task in a team workspace should be a workspace task, so the row and the column can go, is a separate decision.
- The iOS app keeps its own task states and icons until it follows.
