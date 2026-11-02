# Thread lists show cards; every thread opens

- Date: 2026-11-01
- Source: Alex, through the coordinator session, on a bug where a thread in a
  bot's 资料 › 线程 tab, and its card in the chat, could not be clicked: the
  thread list should show cards that look like the chat's thread card, and a
  card opens that thread's own conversation (the thread column's 对话 tab).
- Rule: — (R-52 grouping and R-66 thread cards stand)
- Replaces: —

Every entry in a thread list (a bot's 线程 tab, 全部线程) is the chat's
thread card (`components/coordinator/thread-card.tsx`): status icon, name,
the last reply on one line, a chevron. The whole card opens the thread in the
right column (R-82), whether or not the thread works on a task. A thread with
no task has no task link in its header and no 验收 tab; who may read it is
its owner while an active member of the workspace of the bot that dispatched
it (`taskFreeThreadMembers`, `canReadThread`).
