# Mobile home list: corner marks and row gestures

- Date: 2026-11-05
- Source: Alex, issue #1408: the home chat list follows OpenBot's interactions, including an unread count on the avatar and a waiting mark that outranks it, a long-press menu, a pin swipe and hold-to-drag.
- Rule: R-36, for the mobile home list only
- Superseded by: [2026-11-05-2010](2026-11-05-2010-ios-home-list-interactions.md) (the list that landed). The waiting mark there is a thread waiting on the person, then the unread count, then a hand-marked dot.
- Replaces: the "no dots anywhere" line of [2026-11-01-2230](2026-11-01-2230-nothing-on-bot-avatars.md) for this one list. The web bloub, and every other avatar, stay bare.

The mobile home list (bots and group chats) draws one mark on the avatar's corner. A waiting mark outranks an unread count. Waiting is, in order: the person holds that bot's computer (接管), a pending approval from that bot (批准), a thread still waiting on the person (回答). The unread count is replies after the read position; 100 and above read as 99+. Working stays the row's spinner, not a mark on the avatar.

This is not the status dot 2230 removed (green while working, orange while waiting, drawn on the web bloub).
