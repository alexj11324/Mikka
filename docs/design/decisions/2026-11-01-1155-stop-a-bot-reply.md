# A bot's reply can be stopped from its chat

- Date: 2026-11-01
- Source: Alex, on a production screenshot of the Coordinator chat showing
  「Coordinator is working…」 with only a grey send button:
  「为什么没有办法终止？按照道理来说，聊天过程中我可以直接终止掉。」
- Rule: —
- Replaces: —

While a bot (the Coordinator included) is answering, the composer's send
button is the stop button, in the same place, as threads already have it
(`decisions.md`, 2026-10-27) and as in ChatGPT and Claude: a filled square.
Typing turns it back into send, so a message can still go while the bot
works. Esc in the composer stops too. Web and phone alike.

Stopping ends the turn on the server, not only on screen: the model call in
flight is aborted. What the reply had already said stays in the chat, with
「已停止」 under it; the next message is answered as usual. A dispatched
thread keeps running; it has its own stop. A scheduled read is not stopped
from the chat.
