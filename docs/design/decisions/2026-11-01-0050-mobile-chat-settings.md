# A bot's page: 置顶, 通知 and 资料库, with the server to back them

- Date: 2026-11-01
- Source: Alex, in the mobile session. The bot page had shipped without
  资料库, per-bot notifications and pinning, because the server had none of
  them. He said: 「那你服务器你这后端该加的加，好吧？你没有东西你就加。」
- Rule: —
- Replaces: —

- A bot's page has two switches:
  - **置顶** puts the bot in 对话's pinned row, next to the Coordinator, and
    takes it out of the list. The Coordinator is always pinned.
  - **通知** off stops that chat's pushes. The person's 通知 settings still
    apply on top.
- Both are the person's own, per chat, in `chat_preferences`. They can be set
  only for the Coordinator or the person's own bots.
- **资料库** lists what the bot's threads handed over, newest first.
  - A Markdown document opens in the app.
  - An HTML one opens on the web, signed in, in its sandboxed frame.
- Not done: the web shows neither reactions nor pins, and cannot send in
  group chats. These are web UI, left for the web.
