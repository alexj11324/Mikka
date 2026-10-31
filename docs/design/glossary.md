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
reports the result itself (R-72). Every thread belongs to exactly one bot but
is never drawn with the bot's avatar; it shows a status icon (decisions
2026-10-27), except in the right panel's 全部线程, where each row carries
its bot's 16px avatar (R-50). A cloud thread runs on its own thread machine,
not on its bot's machine (`cloud-computer-backend.md` § 2).

## Rules for designs

- The left column is the **bot list**: bots and group chats only. The right
  column is the **thread list**. There is no "conversation list".
- The bot list holds bots and group chats only. A thread name ("#66 …",
  "MIK-11 …") is never a left-column row. A bot row's preview line may quote
  the latest message, which may mention a thread, but the row is the bot.
- The right panel's 概览 header is the selected bot (the same avatar and
  name as its left row), followed by the tabs 详情 / 线程 / PR / 电脑. A
  thread's name appears only as its row in a thread list, never as that
  header (Alex, 2026-10-28; `rules.md` R-02, R-50).
- Choosing another bot on the left changes the center chat and the right
  column's thread and computer together.
- A task (issue, `MIK-xx`) is not a thread. A thread works on a task, and a
  task can have several threads over time.

## Other words

Decided by Alex, 2026-10-28.

| Word | 中文 | What it is |
| --- | --- | --- |
| **Artifact** | Artifact | Something a thread produces for the person to look at or accept, such as an acceptance (验收), a document or a web page. The word is never translated (not 产物, 工件 or 成果). Lives on the Artifact rail page (R-56). |
| **Library** | 资料库 | A bot's files, listed read-only under 概览 › 详情 (R-51). Files are added with the composer's 「+」. |
| **Thread** | 线程 | As above. The right panel's tab is 线程, never 任务 (R-43). |
| **Browser** | 浏览器 | The person's own local browser, one for the whole app, opened from the globe in the top bar (R-57). |
| **Computer** | 电脑 | A bot's cloud computer, one per bot, shown in the 电脑 tab of 概览 (R-50). Never called 浏览器. |

## Words to avoid

- "会话" / "session" / "conversation list" for the left column. The left
  column is the **bot list** and the right column is the **thread list**.
- "会话" for a run (e.g. "打开会话" on a task's run). Say **线程**.
- "任务" for the right panel's thread tab. Say **线程**.
- A Chinese word for Artifact. Keep **Artifact**.
- "浏览器" for a bot's cloud computer, or "电脑" for the local browser.
- "Agent" when you mean the thing on the left. Say **bot**. **Agent** is the
  right-side worker that runs threads (`agents` table, Claude Code, Codex).
- "harness" or 「执行器」 in the UI for that worker. Say **Agent** (R-43).
- 「E2B」 as the cloud machine's name. It is **Mikka Cloud** in both languages,
  never translated; E2B names only the provider and its API key.
  Code identifiers may keep `harness`.
