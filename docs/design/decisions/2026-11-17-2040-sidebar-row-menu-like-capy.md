# 侧栏 Bot 行：展开箭头和右键菜单照 Capy 的 Captain 行

2026-11-17：Alex 看了侧栏截图后说：「即使下面没有线程，是不是都要加那个符号？……应该是隐藏起来，hover 上去才有感觉的呀」和「右键应该是有反应的吧？……像 Capy 的 Captain 右键会有各种功能，而你什么都没有」，要求照 Capy 桌面版的做法改。

参照的是 Capy 0.9.1 桌面安装包里的 `shared/sidebar-threads.tsx`（`CaptainRow`）：Captain 有 crew 线程时才画展开箭头，收起时箭头透明，指针移到行上或键盘焦点进入时才出现，展开后一直显示；整行是右键菜单的触发区，手机上长按打开同一个菜单。

## 决定

- Bot 下面没有线程、任务，也没有「查看全部」时，这一行没有展开箭头，就是一行普通的 Bot。
- 有子项的 Bot 行：收起时箭头在指针悬停或键盘焦点进入这一行时才出现，展开后一直显示；没有悬停的触屏设备一直显示。箭头仍在行尾，和它原来的位置一样。
- Bot 行和群聊行都有右键菜单（键盘用 Shift F10 或菜单键），用 App Shell 自带的右键菜单样式：
  - Bot（含 Coordinator）：在新标签页中打开、查看全部（这个 Bot 的线程目录）、标为已读 / 标为未读。
  - 群聊：在新标签页中打开、标为已读 / 标为未读、退出群聊（自己创建的群不显示；确认框与群聊页面上的同一个）。
- 每一项都用已有的写入路径：个人的聊天偏好（`lib/chat-preferences.ts`，`PATCH /api/mobile/bots|groups/<id>`）、已读位置（`POST /api/conversations/<id>/read`）和群成员退出命令。写入失败时提示「未能保存已读状态，请重试。」，侧栏由这些写入自己推送的列表变化更新。
- Capy 菜单里 Mikka 网页侧栏还表现不出来的项（置顶、移到文件夹、归档、删除）先不加：网页侧栏还不按置顶和隐藏排列，加了会让人以为操作成功了。

实现：公开仓库 `components/nav/bot-list.tsx`（`ChatNavEntry.actions`）和 `components/nav/chat-row-actions.ts`；私有 `mikka-hosted-ui` 的 `slots/app-frame.tsx` 和 `patches/app-shell.sidebar-row-menu.patch`（`ShellNavItem.menu`）。补充 [2026-11-10-1317](2026-11-10-1317-capy-sidebar-and-task-layout.md) 的「Sidebar」一节。
