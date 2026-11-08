# iOS chat: no message drag, long press selects, times as separators, a glass title pill

- Date: 2026-11-08
- Source: Alex on TestFlight, relayed by the coordinator with screenshots of a bot chat (「iOS 助手」), a reference app whose header is a glass pill with the bot's avatar and name, and Grok's header.
- Rule: `apps/mobile/components/chat.tsx` (`MessageRow`, `TimeSeparator`, `MessageActions`), `apps/mobile/lib/chat-time.ts`, `apps/mobile/features/chat/components/chat-title-pill.tsx`
- Replaces: swipe-to-quote and the swipe-left times (Figma 01b), and the long-press reactions sheet

1. No drag on a message. Swiping right no longer quotes, swiping left no longer shows times; the left edge is only the system's swipe back.
2. A long press selects the message's words in place, with the system handles. While words are selected, 「添加到对话」 leads the capsules above the composer and puts the selection into the composer as its quote; nothing is sent. On iOS builds that carry `modules/selectable-text` (a read-only UITextView whose `editMenuForTextIn` delegate adds the action), 「添加到对话」 is the first item of the system edit menu and the capsule is not drawn; older binaries and the web build keep the capsule.
3. Reactions, 回复, 复制 and 选择文本 live in ⋯ under each bot reply, and under other members' messages in a group (the system menu on iOS). The person's own messages have no ⋯: a long press selects their words. 复制 also sits beside ⋯ under the bot's latest reply.
4. Messages carry no time. A centred time separates groups: a new one after a gap of 15 minutes or more, or a new day. 「09:21」 today, 「昨天 21:04」, 「星期五 14:11」 within the past week, 「11月3日 14:11」 before that (with the year when it is not this year).
5. The chat's title is the bot's avatar and name in one frosted-glass pill, centred; a tap opens its page. Back and ⋯ (its tasks, 全部任务, 资料) are separate glass circles. Messages scrolled under the bar dissolve through a soft edge (the system's on iOS 26, a short fade from the page colour before it), never cut at the bar. Decision 0120's rule holds: one centred title, buttons on the right.
