# A reply's tools read as one summary line; an object shows once

- Date: 2026-11-04
- Source: Alex, reviewing the Coordinator chat on a phone, relayed by the coordinator session
  (session_01XDndLThEHgcdfvzQakrYDT): 「为什么你那里会出现两个 mention chips？正常情况下应该是几个，你看看同类型的产品，
  它到底还会有几个 chips 总是显示在 chat 界面上？」 and 「上面全是 error 也算是一个工具吗？你的工具调用到底该怎么写？
  你去查一查各家是怎么样去做的。」 The coordinator approved the spec `docs/design/chat-tool-calls.md`, built on the
  comparison `docs/design/research/chat-tool-calls-and-citations.md` (Codex, Claude, ChatGPT, Cursor, Warp).
- Rule: R-83 (new), R-15, R-66
- Replaces: in [2026-11-04-2105-reply-trace-in-order.md](2026-11-04-2105-reply-trace-in-order.md), a row per tool
  inside the shared Trace (the order stays)

Two or more tools with nothing said between them are one line that says what they did, side effects first and
failures counted (「派发了 1 个线程，查看了 3 次任务 · 1 个失败」), closed by default; it opens to a row per call, each
its kind's icon and verb plus object (「查看任务 ALEX-45」). A call that answered `{"error": …}` is a failure, red, with its
reason in words. Raw input and output open only from that call's row. Any group's 全部展开 opens or closes every
group in the chat. A task whose thread the same reply cites shows as its title, only the thread is a chip; a thread
has one card per chat; a thread's repeated event line shows once, the latest. 「N 个来源」 lists web pages only and
sits beside 复制 in one line that is always there, muted until hovered or focused ([decision](2026-11-10-2002-chat-reply-actions-and-waiting.md)).
