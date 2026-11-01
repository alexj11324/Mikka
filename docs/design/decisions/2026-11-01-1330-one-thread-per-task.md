# A task has one thread at a time

- Date: 2026-11-01
- Source: Alex, after task ZHIX-2 collected 17 threads, each a new dispatch
  by the Coordinator (Failed and Stopped mixed):
  「一个 task 理论上只能由一个 session 或者 thread 来接手，怎么能同时派发给这么多？你要添加信息，应该直接添加给那个 session，而不是重新开一个 session。你要重新派发，也是重新派发给那一个 session，不允许你重新开。除非我明确说了我要换，那可以重新开。我没有明确说，就不允许你重新开。」
- Rule: R-81
- Replaces: —

A task has one thread at a time, per person. The server enforces it at every
dispatch entry (`lib/thread-dispatch.ts`): the Coordinator's and every bot's
`dispatch_run` and `dispatch_bot_computer`, the Bot computer API
(`POST /api/bots/:botId/computer/runs`) and MCP `dispatch_run`. A prompt
alone is not enough.

- The task's thread is still working: the dispatch's note goes in as a
  message (queued for the agent's next poll). Nothing new is queued.
- The thread ended (done, failed or stopped): the same thread runs again.
  The new run points at the one it goes on from (`agent_runs.continuesRunId`),
  so the run chain, and with it the thread and its id, stays the same. On the
  same device in the thread's worktree the agent's Claude Code or Codex
  session is resumed and sent only the note; elsewhere a new session gets the
  full brief with how the thread last ended.
- A new thread only when the person explicitly asked for one ("换一个
  session", "重新开", "换 Codex"). The Decision API judges the person's own
  message, never a keyword list; anything else, an unavailable judgment
  included, keeps the existing thread. The old thread is stopped and its root
  run records the thread that replaced it (`agent_runs.threadReplacedBy`).
- An MCP client has no chat message of the person's to judge, so it never
  starts a second thread.
- Factory attempts and the server's own recovery runs (a lost machine, a
  used-up quota) already continue their thread and are not affected.
- Existing threads are left as they are; folding them in 线程 is a separate
  change.
