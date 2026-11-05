# iOS: one Stack in a push drawer, the chat list as home

- Date: 2026-11-05
- Source: Alex, after checking the app on his phone (relayed by the coordinator at 20:00 UTC; #1408 corrected at
  20:05): the app still looks like the old Mikka. OpenBot has no tab bar; its whole app is one Stack inside a push
  drawer. Follow its structure, not only its libraries.
- Rule: —
- Replaces: [2026-11-05-1300](2026-11-05-1300-ios-no-drawer.md) (the tab bar and the account sheet).
- Refined by: [2026-11-05-2205](2026-11-05-2205-drawer-native-surface.md) (the open surface's material).

- No tab bar and no floating search button. The app is one Expo Router Stack on a surface that lies over a drawer.
- **Push drawer.** The drawer sits at the left edge under the app. Opening it slides the whole surface right by the
  drawer's width, `min(360, max(280, screen width − 52))`. The surface rounds to the screen's corners (at least
  34 pt), casts a shadow on the drawer and dims.
  - It opens by a drag to the right on the home screen only: the drag starts after about 12 pt and gives way to
    about 10 pt of vertical movement. The home bar's workspace button opens it too.
  - A tap on the dimmed surface or a drag back closes it.
  - Spring of about 300 ms, damping ratio 0.8, no overshoot, honouring Reduce Motion. A light haptic on open and on
    close. VoiceOver reads the drawer from the moment it starts to open until it has closed.
  - Its live values (counts) draw only once it has settled open.
- **Drawer content.** The open workspace at the top. Tapping it lists the workspaces in place, to switch, and 排序
  arranges them (kept on the device). Then 线程, 任务, 建议 and 插件, with counts. The person (avatar, name, email)
  and 设置 are pinned at the foot.
- **Home.** The chat list is the first screen. Its native bar holds the workspace button and 新建 (新建 Bot,
  新建群聊), with the system search field under it. Pinned bots sit on top as tiles, then 正在工作, Bot and 群聊.
- Every other page (线程, 任务, 建议, 插件) is pushed from the drawer as a large-title Stack page. 设置 stays the
  modal it was.
