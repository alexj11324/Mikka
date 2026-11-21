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
- 同日 Alex 追加：「删除和归档 BOT，这个功能要加上」，做法「capy 怎么做，你就怎么做」。照 Capy 的 Captain：
  - 归档：菜单里一点就归档，提示「已归档「名字」」。归档的 Bot 保留聊天和历史，离开侧栏的 Bot 列表，不再接新工作（派发和定时任务本来就跳过归档的 Bot）。它列在 Bot 列表末尾折叠的「已归档」下面，点一行打开它的菜单：取消归档、删除。
  - 删除：先问「删除「名字」？」，说明它的聊天记录会被永久删除、它派出的任务和线程会保留；按钮是取消、改为归档、删除，和 Capy 的 Cancel / Archive instead / Delete 一样。删除时 Bot 离开它所在的群聊，它带的线程继续存在但不再归它，它的聊天、附件、会话和定时任务随它删除，它派出的任务和运行记录保留。
  - Coordinator 不能归档或删除，菜单里也没有这两项。
  - 写入在 `lib/bot-lifecycle.ts`（`archiveBot`、`deleteBot`、`listArchivedOwnBots`，Desktop RPC 同名）。
- 同日 Alex 追加「这他妈都得做」：Bot 和群聊行加上个人资料、复制链接、置顶 / 取消置顶、静音、隐藏 / 取消隐藏（侧栏按置顶排列，隐藏的折叠在「已隐藏」下）；线程行的右键菜单有在新标签页中打开、复制链接、置顶、重命名、标为已读 / 未读、归档。移到文件夹仍不加：Mikka 没有侧栏文件夹。行的样子见 [2026-11-18-1200](2026-11-18-1200-sidebar-rows-as-capy.md)。

实现：公开仓库 `components/nav/bot-list.tsx`（`ChatNavEntry.actions`）和 `components/nav/chat-row-actions.ts`；私有 `mikka-hosted-ui` 的 `slots/app-frame.tsx` 和 `patches/app-shell.patch`（`ShellNavItem.menu`、`menuOnClick`）。补充 [2026-11-10-1317](2026-11-10-1317-capy-sidebar-and-task-layout.md) 的「Sidebar」一节。
