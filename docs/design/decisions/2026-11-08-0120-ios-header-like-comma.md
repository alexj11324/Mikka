# iOS headers: one centred title, no bar slab

- Date: 2026-11-08
- Source: Alex on TestFlight after OTA 8e208aa5, relayed by the coordinator with Comma's Inbox as the reference: the Bot and 任务 tabs showed the title twice (a big left-hand title and the native centred one), and a chat's top was an opaque grey slab with a back button and no name.
- Rule: `apps/mobile/components/NavBar.tsx`, `apps/mobile/components/nav-bar-options.ts` (pinned by `apps/mobile/tests/nav-bar-options.test.mts`)
- Replaces: the top-row left title of 2026-11-07-2045 and the material bar of 2026-11-07 on tab roots and chats

Every tab root (Bot, 任务, 建议, 设置, 搜索) has one title, the system's own,
centred in the bar's row at the navigation-title size. Its buttons sit grouped
in one glass capsule on the right (任务: filter and +; Bot: +). Nothing sits on
the left.

No bar is a slab. The header is the page's own background: transparent, no
material, no hairline. Content scrolled under it fades out through the
system's soft top edge on iOS 26; below 26 the bar draws a short fade from the
page colour. Buttons stay floating glass circles and capsules.

A chat shows the bot's name centred in the top row, back on the left; the name
still opens the chat's title menu.
