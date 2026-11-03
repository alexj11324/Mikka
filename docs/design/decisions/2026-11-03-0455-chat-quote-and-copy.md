# Quote a reply and copy any message in chat

- Date: 2026-11-03
- Source: Alex, relayed by the Coordinator session for the chat-components batch: 「在助手回答里选中一段文字，弹出一个小浮层，上面有『引用』按钮，交互参考 Claude 和 Codex……不要做侧边栏里那种 side chat」「每条助手回答、每条用户消息都要有复制按钮。助手回答复制出来的是 markdown 原文」
- Rule: —
- Replaces: —

In the Coordinator or bot chat and in an open thread, selecting words in a reply shows a small 引用 button above
the selection. It puts the words above the draft as a quote chip (removable, `QuoteChip`); the sent message shows
them as a quote line (`QuoteLine`, the `ArtifactQuoteLine` look) above the person's words. The quote rides at the head
of the message as Markdown quote lines (`> …`, `lib/chat-quote.ts`), the format the phone app already sends, so the
Coordinator and a thread's agent read it in place. There is no side chat.

Every reply and every person's message has 复制 under it (AI Elements `MessageAction`): on hover or focus, always on
a touch screen and under the newest reply. A reply copies its Markdown as written; a card copies its prose and words.
The icon turns into a tick for two seconds. Code blocks keep their own 复制.
