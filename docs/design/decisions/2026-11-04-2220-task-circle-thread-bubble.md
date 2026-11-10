# A task is a circle, a thread is a bubble

- Date: 2026-11-04
- Source: Alex, in the Claude Code session that redesigned the chat's tool calls and citations
  (https://claude.ai/code/session_01XDndLPgmtUBPajCU43rJKp), looking at the chat on a phone:
  「现在你的 issue 状态跟 chat 状态，我是有点分不清楚的。你画得太像了」，then
  「issue 和这个 chat 的状态要有区分度，一看就让人知道哪个是 issue，哪个是 chat」。
  The shape below was proposed in that session and approved by the coordinator session
  (session_01XDndLThEHgcdfvzQakrYDT) on review of `docs/design/chat-tool-calls.md`.
- Rule: R-15, R-52, R-66
- Replaces: [2026-11-02-0220-waiting-raises-a-hand.md](2026-11-02-0220-waiting-raises-a-hand.md)
  (every thread state is now a dot on the bubble; 等待你 is the amber one)
- Superseded in part by: [2026-11-07-2045-tasks-only-threads-inside.md](2026-11-07-2045-tasks-only-threads-inside.md) (lists show tasks only, so the thread bubble no longer appears in a list)

A task and a thread never look alike. A task is always its board status circle (○ ◌ ◉ ✓ ✕ ⊘). A thread is
always a speech bubble, with its state as a dot on the bubble's corner: 进行中 a pulsing grey dot, 等待你 amber,
受阻 red, 已解决 green, 空闲 a hollow ring. The thread side borrows no circle icon anywhere (the old 已解决 check
and 空闲 slashed circle were the very icons a task used). The dot is never the only sign: lists, cards and
badges write the state beside it, and the icon's label names it. The board card's agent badge and the 全部线程
waiting count use the same dots. `scripts/ui-policy.mjs` (`icons/thread-not-circle`) keeps circles out of
`ThreadStatusIcon`.

The phone app (`apps/mobile`) draws the same bubble and dot with its native colours (等待你 is systemOrange there): its `StatusIcon` and the 线程 filter menu, which shows each group's bubble and uses the `bubble.left` symbol in the native menu.
