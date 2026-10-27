# Glossary: bot, thread, chat

This file is the single definition of these words. Specs, designs, issues and
code comments use them in this sense. When a document disagrees with this
file, this file wins and the other document gets fixed.

Decided by Alex, 2026-10-24.

## The three things

| Word | 中文 | What it is | Where it shows | Its name |
| --- | --- | --- | --- | --- |
| **Bot** | Bot | Chats with people. Does web tasks itself through sub-agents (分身, R-72), each with its own browser, and dispatches real tasks such as coding to threads. The user creates it (Grok Bot style) and can put several bots in a group chat. The Coordinator is a bot too. Stored in its own `bots` table (name, colour, shape) and runs on Mikka's AI SDK harness; it is not a row in `agents`. | **Bot list** (left column), one row per bot or group chat. | The bot's own name, e.g. "Mikka Frontend". |
| **Chat** | 对话 | The conversation between a person and the selected bot or group chat. | **Center column**. Header pill = the bot's (or group's) name. | Same as the bot or group. It has no name of its own. |
| **Thread** | 线程 | Does the work a bot dispatched: one run (`agent_runs`), usually tied to a task. A bot can have many threads at once. | **Thread list** (right column), plus the thread view and its computer. | Its own name, about the work, e.g. "#66 群聊前端骨架" or "MIK-11 群聊建表". Never the bot's name. |

How they connect: a person chats with a bot (center). The bot dispatches
real tasks such as coding to threads, which do the work (right). A web task
stays with the bot: one of its sub-agents (分身) does it in its own browser,
it shows only as a card in the chat, never in the thread list, and the bot
reports the result itself (R-72). Every thread belongs to exactly one bot and shows that
bot's avatar. The computer a thread uses is its bot's computer.

## Rules for designs

- The left column is the **bot list**: bots and group chats only. The right
  column is the **thread list**. There is no "conversation list".
- The bot list holds bots and group chats only. A thread name ("#66 …",
  "MIK-11 …") is never a left-column row. A bot row's preview line may quote
  the latest message, which may mention a thread, but the row is the bot.
- The right panel's 详情 header is the selected bot (the same avatar and
  name as its left row), followed by 「<Bot 名> 的屏幕」. A thread's name
  appears only as its row in the thread list, never as that header
  (Alex, 2026-10-24 21:13; `rules.md` R-02).
- Choosing another bot on the left changes the center chat and the right
  column's thread and computer together.
- A task (issue, `MIK-xx`) is not a thread. A thread works on a task, and a
  task can have several threads over time.

## Words to avoid

- "会话" / "session" / "conversation list" for the left column. The left
  column is the **bot list** and the right column is the **thread list**.
  `agent_sessions` and
  `components/nav/conversation-list.tsx` are today's implementation, which
  still lists sessions; that is a known gap, not the model.
- "会话" for a run (e.g. "打开会话" on a task's run). Say **线程**.
- "Agent" when you mean the thing on the left. Say **bot**. "Agent" is fine
  for the coding agents that run threads (`agents` table, Claude Code, Codex).
