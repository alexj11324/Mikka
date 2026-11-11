# Quote a reply and copy any message in chat

- Date: 2026-11-03
- Source: Alex accepted the Figma page 902:2 「待 Alex 确认 · 聊天引用与复制（2026-11-03）」 in file `zPe5LKycb2XuT1ivCLRw07` on 2026-11-03, relayed by the Coordinator session of the chat-components batch. Each frame shows light (left) and dark (right).
- Rule: —
- Replaces: —
- Amended by: [2026-11-10-2002-chat-reply-actions-and-waiting](2026-11-10-2002-chat-reply-actions-and-waiting.md) (a reply's actions are always visible, not hover-only)

Accepted frames:

| Frame | Node | What it fixes |
| --- | --- | --- |
| C1 | `903:2` | Hovering a reply or a person's message shows 复制 under it (ghost `icon-xs`); a reply copies its Markdown as written |
| C2 | `910:2` | Words selected in a reply show the Artifact reader's 引用 / 复制 popover (`SelectionActions`, one component for both) |
| C3 | `905:2` | 引用 puts the words above the draft as a removable quote chip (the `ArtifactQuoteChip` look) |
| C4 | `906:2` | The sent message shows the quote at the top of the blue bubble (`ArtifactQuoteLine`), in the bubble's own text colour so it reads on blue |
| C5 | `907:2` | After 复制 the icon is a tick and 「已复制」 shows beside it for about two seconds |
| C6 | `908:2` | Thinking stays as it is |

There is no side chat. Both the Coordinator or bot chat and an open thread have all of it. The quote rides at the head of
the message as Markdown quote lines (`> …`, `lib/chat-quote.ts`), the format the phone app already sends, so the
Coordinator and a thread's agent read it in place and no new artifact-quote kind is needed.
