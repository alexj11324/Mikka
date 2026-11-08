# A reply's words and tools read top to bottom, in the order they happened

- Date: 2026-11-04
- Source: Alex, GitHub issue #1235: 「按照道理来说应该是从上往下的顺序，他已经把文字发出来了，那下边这个 Tool use 工具调用之类，都应该放在这段话的下边才对啊。」
- Rule: —
- Superseded in part by: [2026-11-04-2221](2026-11-04-2221-chat-tool-groups-and-citations.md) (consecutive tools share one collapsed summary line; their order remains).
- Replaces: one Trace above the whole reply ([1659](2026-11-04-1659-reply-trace.md) drew every tool before the words)

A reply is drawn as it happened: its thinking first, then its words, and each tool after the words the model said before
calling it; words said after a tool come below it. Tools with nothing said between them share one Trace. Live and stored
replies look the same: a tool call carries how much of the reply's text came before it (`at`), streamed with the call
and computed from the stored steps (`lib/coordinator/reply-segments.ts`).

The chat also re-reads as soon as a turn starts, so its stream (and the live Trace) connects at once instead of after
the quiet 30-second poll.
