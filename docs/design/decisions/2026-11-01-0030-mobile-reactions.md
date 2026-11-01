# The iOS app: 新建 Bot, group chats and reactions, in one go

- Date: 2026-11-01
- Source: Alex, in the mobile session: 「表情回应那里，你可以做，你排到后面去」
  (2026-10-31), then 「你不要就是说弄成这么小一个 PR…你一次性做完行不行」
  (the bot page, 新建 Bot, 新建群聊 and reactions ship together).
- Rule: —
- Replaces: —

- 对话's 「+」 (top right) opens a menu: **新建 Bot** and **新建群聊**.
  - 新建 Bot asks what the web's dialog asks: a name, a shape and a colour.
    The phone offers the six shapes it can draw. The new bot's chat opens.
  - 新建群聊 asks for a name and the bots in it. The group opens.
- Group chats are listed in 对话 with the bots, newest first. A dot marks
  unread ones.
- In a group, the person's messages sit on the right in blue. Each bot's sit on
  the left, under its name and avatar.
  - A message goes to the bots it names as `@name`. Otherwise it goes to the
    ones Mikka judges should answer.
  - When none takes it, the chat says to @ one.
  - The web and the phone both send in groups, through the same API.
- **Reactions:** the long-press sheet opens with a row of six: ❤️ 👍 👎 😂 🎉 🙏.
  - Each person keeps one reaction per message. Choosing another replaces it;
    choosing the same one removes it.
  - Reactions show under the message as chips, with a count past one. Tapping
    the person's own chip removes it.
  - They work in bot chats and group chats. The server keeps them
    (`message_reactions`). 现状（非决定）：the web does not show them yet.
