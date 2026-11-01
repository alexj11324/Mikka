# The iOS home: avatar and drawer at the top left, 「+」 at the top right, search at the bottom

- Date: 2026-11-01
- Source: Alex, in the mobile session. He sent a screenshot of the Grok-style
  bot list and of ours with 对话 and the search field circled: 「你上边那个对话
  跟搜索框什么鬼啊？你看人家没有啊…然后我们抽屉也没了，添加按钮也没有」
- Rule: —
- Replaces: 对话's large title, its top search field and its left bar menu
  (decision 2026-10-31-2345-mobile-bot-home)

- 对话 has no title and no search field at the top.
- The person's avatar (top left) opens the side drawer, which is back. The
  drawer holds:
  - the person and workspace (opens 设置)
  - 建议
  - 任务
  - 插件
  - 设置
  - 「重启以更新」
- A swipe right on a tab's root also opens the drawer.
- 「+」 (top right) opens 新建 Bot and 新建群聊.
- Search is the system search tab at the bottom of the tab bar. It finds bots
  and group chats by name.
- Fixed with this change: no bar buttons showed anywhere. This covered the left
  menu, 「+」 and a chat's 「…」. The toolbar keeps only its own button
  components as direct children, and ours were wrapped in another component.
