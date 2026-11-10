# Task chips show the code, threads are links, and a chat opens work in its work-area tabs

- Date: 2026-11-10
- Source: Alex, in the session reviewing #1864 against Capy, Warp Factory and affectUI's Live Session, with screenshots of ALEX-45 shown four ways: 「对于这个任务来说，直接显示图标加编号。我们的 run 还是显示标题。对于 issue，我们仍然选择全屏……如果是在对话里边打开，就显示侧栏。右侧标签页的话，比如我们看 sub agents，点一下就自动在右侧标签页里面开一个新的标签页」; on threads: 「在它前面不加任何强调色，但还是要加引用的连接色」; on Agent 配置: 「给每一个不同的 Agent 配上不同的图标」.
- Rule: R-15, R-78, R-82
- Replaces: R-15's title chip with the number in the hover card; R-78's Agent brand mark as the only mark of a thread's Agent stretch; R-82's chat-opened task detail in the right column.

## References in chat text

- A task is one chip: its state icon (R-52) and its code, such as 「◐ ALEX-45」. The title, state and priority are in the hover card. A task with no code shows its title instead.
- A thread (a run chain) is its title in the link colour. It has no icon, no chip fill, no accent and no state badge. The title is the task's title without its code, or the run's own name when it has no task, so 「◐ ALEX-45」 and the thread's title never repeat the code.
- The state beside a task is the task's own state (`localTaskState`, R-52) on every surface: chips, the dispatch card, task rows, the task page and the work-area tab. A run's result, a thread group, a Factory stage or the dispatching Bot's name is never shown as the task's state.

## Where work opens

- From a task list, 看板, 收件箱 or a link, a task opens as a full page.
- From a chat, a task opens in the chat's right work area as a tab, using the same task view. Its expand button opens the full page of the same task.
- A thread, an Agent stretch or a subagent opened from a chat or a task opens its own work-area tab with its conversation. A tab that is already open is reused. On the phone the tab is pushed full screen.
- The chat keeps the Bot's words, the dispatch card and one line per handoff. Subagent conversations never appear in the chat's text.

## Agent 配置 icons

Each Agent 配置 has its own mark, chosen from a closed set of glyphs and colours, with a default from its role. The mark says who does a stretch of work. The Agent's brand mark (Claude Code, Codex) stays beside it, smaller, or in the details, and says what runs it. Profile marks appear in settings, the New task picker, the line where the Agent changes, the plan's steps and the run's execution identity. They never appear on a thread reference in text.
