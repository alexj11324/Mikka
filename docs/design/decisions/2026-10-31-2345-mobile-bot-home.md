# The iOS app opens on its bots, with tabs

- Date: 2026-10-31
- Source: Alex, in the mobile session, with screenshots of the Claude app's
  Chat · Tasks · Make tabs and a messaging app's bot list: 「主页呢我们就改成
  这个…右上角就可以添加 Bot 或者是新建群聊」, 「所有的这些 task 我们叫
  thread…waiting for you、running 之类的都在那上面」, 「人家的 orchestrator
  是有图标的…点了之后，就会进入到这个界面」, 「从左往右滑动卡片，触发的是
  引用功能；只有从屏幕边缘滑动，才会退出」, 「这些回答我没有办法进行复制」
- Rule: —
- Replaces: the side drawer and the Coordinator chat as the home screen
  (mobile.md "Where it lives", decisions 2026-10-27, 2026-10-31-2200's drawer)

- The app opens on **对话**: the Coordinator pinned on top with a star, then
  every bot and group chat with its last line and time, newest first; the
  system search field filters them. The bar's left menu opens 设置, 插件,
  建议 and 任务. 「重启以更新」 sits at the top when an update is ready.
- The system tab bar holds **对话** and **线程**. 线程 groups every thread by
  state: 等你回复, 进行中, 失败, 已完成, with the filter menu and 新线程 in the
  bar.
- A chat opens over the tabs. The bot's name, in its capsule at the top, opens
  the bot's page, which holds what the desktop app shows beside the chat
  (线程 first; 电脑, PR, 定时任务 and 资料库 follow).
- In a chat, dragging a message from left to right quotes it in the composer;
  only a swipe from the screen's edge goes back. The composer is one field as
  in the Claude app: the quote, the words, then 「+」 and send.
- A bot's reply has 复制 under it, and every message's text can be selected.

Defaults Alex left standing when asked: two tabs (对话, 线程); the
Coordinator pinned first. 新建 Bot and 新建群聊 from 「+」 come next, with
their mobile endpoints.
