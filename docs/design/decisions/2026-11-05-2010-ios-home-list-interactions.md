# iOS: the home chat list's interactions follow OpenBot's

- Date: 2026-11-05
- Source: Alex, via the coordinator (#1408 corrected at 20:05 UTC, "Home chat list"): Mikka's chat rows only respond
  to a tap; follow OpenBot's interactions as well as its structure.
- Rule: —
- Replaces: —
- Superseded in part by: Alex, 2026-11-07, on the device: 「为什么这个 BOT 是可以移动的呀？……这种东西怪得很」. Hold-to-drag is removed from the list and the pin grid; order stays newest first, and pinning stays (swipe and the long-press menu).

- **Tap** opens the chat with the system's link transition.
- **Long press** opens the system context menu over a live preview of the chat:
  - 标为已读 / 标为未读
  - 置顶 / 取消置顶
  - 隐藏
  - 信息, for a bot only
  - 更多 › 复制 ID
  - Mikka has no 复制一个 or 删除 for a chat, and a group chat has no page of its own, so those items are left out.
- **Swipe left** on a row:
  - 置顶 shows at 88 pt. A full swipe past 144 pt pins the chat on release, with a light tick as it passes.
  - At the limit of 16 pins it gives the warning tick instead.
  - A swipe right on a closed row is the drawer's; on an open row it closes the row.
- **Hold 250 ms, then move** drags the chat:
  - Its avatar follows the finger and a line marks where it will land.
  - The list scrolls while the finger rests within 72 pt of its top or bottom edge.
  - Dropped among the pins, it is pinned or its pin moves. Dropped in the list, it is placed there, within its own section, and unpinned.
  - A move before the hold scrolls or swipes instead.
- **Pins** are a four-column grid of avatars, each with the row's menu and drag.
- **Sections** (正在工作, Bot, 群聊) fold with a chevron. A folded section shows its unread count.
- **Avatar badge:** a waiting mark (a thread waits on the person) outranks the unread count. A chat marked unread by hand shows a dot.
- **Hidden chats** leave the list. 隐藏的聊天 at its foot lists them, each with 取消隐藏.
- **Where it is kept:** the server keeps hidden, marked-unread and the drag order per person and chat
  (`chat_preferences`, drizzle/20261105203000).
- **Drawer:** 编辑顺序 reorders the workspaces by dragging a handle; the order is kept on the device. Mikka has no way
  to leave a workspace yourself, so there is no 离开.
