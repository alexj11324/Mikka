# Glossary: bot, thread, chat

This file is the single definition of these words. Specs, designs, issues and
code comments use them in this sense. When a document disagrees with this
file, this file wins and the other document gets fixed.

Decided by Alex, 2026-10-24.

## The three things

| Word | 中文 | What it is | Where it shows | Its name |
| --- | --- | --- | --- | --- |
| **Bot** | Bot | Chats with people. Does web tasks itself through sub-agents (分身, R-72), each with its own browser, and dispatches real tasks such as coding to threads. The user creates it (Grok Bot style) and can put several bots in a group chat. The Coordinator is a bot too. Stored in its own `bots` table (name, colour, shape) and runs on Mikka's own AI SDK on Vercel; it is not a row in `agents`. | **Bot list** (left column), one row per bot or group chat. | The bot's own name, e.g. "Mikka Frontend". |
| **Chat** | 对话 | The conversation between a person and the selected bot or group chat. | **Center column**. Header pill = the bot's (or group's) name. | Same as the bot or group. It has no name of its own. |
| **Thread** | 线程 | Does the work a bot dispatched: one run (`agent_runs`), usually tied to a task. A bot can have many threads at once. | **Thread list** (right column), plus the thread view and the machine its Agent runs on. | Its own name, about the work, e.g. "#66 群聊前端骨架" or "MIK-11 群聊建表". Never the bot's name. |

How they connect: a person chats with a bot (center). The bot dispatches
real tasks such as coding to threads, which do the work (right). A web task
stays with the bot: one of its sub-agents (分身) does it in its own browser,
it shows only as a card in the chat, never in the thread list, and the bot
reports the result itself (R-72). Every thread belongs to exactly one bot but
is never drawn with the bot's avatar; it shows a status icon (decisions
2026-10-27), except in the right panel's 全部线程, where each row carries
the 16px mark of the Agent running it (R-50, R-78). A bot does no coding
work itself: an Agent (Claude Code, Codex) runs every thread. A cloud thread runs on its own thread machine,
not on its bot's machine (`cloud-computer-backend.md` § 2).

## Workspaces

| Word | 中文 | What it is |
| --- | --- | --- |
| **Account** | 账号 | The person: 账户, security, 偏好, 通知, profile memory (个人资料类记忆), 登录与密钥, 设备 and 「API 与订阅」. The same in every workspace. |
| **Personal workspace** | 个人工作区 | One per person. Only that person's bots, chats, tasks, threads and their memory; personal 计费 and 用量; no team settings. |
| **Team workspace** | 团队工作区 | Members, 团队权限, 密钥与环境, 审计日志, team 用量 and 计费. Nothing moves between it and a personal workspace. |

Decision: [2026-11-01-2310](decisions/2026-11-01-2310-personal-and-team-workspaces-apart.md).

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
| **Agent** | Agent | The coding agent that runs a thread: Claude Code, Codex, Cursor (`agents` table, a harness). It does the coding work; a bot never does. Shown by its own brand mark wherever a thread or run has an icon (R-78). Never called harness or 执行器 in the UI (R-43). |
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
- 「Mikka Cloud」 for the hosted model, or 「Mikka 默认」 for the cloud machine.
  Mikka 默认 is a model, Mikka Cloud is a machine ([orchestration](orchestration.md) § 1).

## Domain terms: tenancy and ownership

Who owns what, in the format of the domain-modeling skill's glossary
(`mattpocock_skills` `GLOSSARY-FORMAT.md`). Each term names the aggregate it
belongs to (DDD: the consistency boundary that owns it). Where a line below
and the Workspaces table above differ about 密钥与环境, the line below follows
[2026-11-02-0230](decisions/2026-11-02-0230-workspace-is-the-tenant.md), which
waits for Alex's confirmation. Bounded contexts, aggregates and the code that
stores them: [information-architecture.md](information-architecture.md) § 1.

### People and tenants

**Account (账号)**:
The person. Not a tenant: what is bound to the person follows them into every
workspace they belong to.
_Owner_: itself (Account aggregate).
_Avoid_: 账户 for the whole level (账户 is one settings page), user, profile.

**Workspace (工作区)**:
The tenant. Every bot, chat, task, thread, secret, credit and invoice belongs
to exactly one workspace, and nothing crosses between workspaces.
_Owner_: its owner account; administered by its admins (Workspace aggregate).
_Avoid_: 工作空间, organization, space, team (for the workspace itself).

**Personal workspace (个人工作区)**:
A workspace with exactly one member, created with the account and kept as long
as the account exists. It has everything a workspace has except what is
between people.
_Owner_: the account (Workspace aggregate).
_Avoid_: 个人空间, "my account", the personal level.

**Team workspace (团队工作区)**:
A workspace with more than one possible member. Only it has what is between
people: members, teams, roles and team permissions, member audit, shared
credits and seats, transfer.
_Owner_: its owner account; administered by its admins (Workspace aggregate).
_Avoid_: 团队 on its own (a 团队 is a group inside a workspace), organization.

**Team (团队)**:
A named group of members inside a team workspace, with its own task prefix,
tasks and projects (as a Linear team).
_Owner_: the team workspace (Team aggregate).
_Avoid_: 团队 for the workspace, group, squad.

**Member (成员)**:
An account's place in one workspace, with a role (管理员 or 成员) and a state
(active or suspended).
_Owner_: the workspace (inside the Workspace aggregate).
_Avoid_: user, seat (a seat is a billing count), collaborator.

### Work

**Bot**:
As defined above. It lives in one workspace and has one owner account; a
person's Coordinator is their bot in that workspace.
_Owner_: the workspace, held by the owner account (Bot aggregate).
_Avoid_: Agent, assistant, 机器人.

**Agent**:
As defined above: the coding worker (Claude Code, Codex) that runs a thread.
Which Agent a person's bots use is the person's choice per workspace
(Bot 与 Agents).
_Owner_: the account (Agent aggregate).
_Avoid_: harness, 执行器, bot.

**Thread (线程)**:
As defined above: one piece of work a bot dispatched, run by an Agent.
_Owner_: the workspace of the bot that dispatched it (Thread aggregate).
_Avoid_: 会话, session, 任务, run (a run is one turn of a thread).

**Task (任务)**:
A unit of work to be done, with a status and an assignee who is always a
person (`MIK-xx`). A thread works on it; it is not a thread.
_Owner_: the workspace; in a team workspace, its team (Task aggregate).
_Avoid_: issue in the UI, ticket, 工单, thread.

### Resources

**Device (设备)**:
A computer or server of the person's that runs their Agents through the
desktop app or the daemon. Not a bot's cloud computer (电脑).
_Owner_: the account (Device aggregate).
_Avoid_: 电脑 (a bot's cloud computer), machine in the UI, runner.

**Connection (连接)**:
The person's authorised link to an outside app (Gmail, GitHub, Linear,
Telegram…), used only by their own bots unless a workspace policy says
otherwise.
_Owner_: the account (Connection aggregate).
_Avoid_: integration, plugin (a 插件 is the store item, the connection is
what linking it creates), binding.

**Secret (密钥)**:
A named value, secret or environment variable, injected into the runs of one
workspace, or of one repository in it.
_Owner_: the workspace (Secret aggregate).
_Avoid_: credential (a model credential is the account's), token, 环境变量 as
a separate thing (an environment variable is a kind of secret).

**Credits (点数) and free allowance (免费额度)**:
Credits are what a workspace spends on Mikka 默认 and pays for; the free
allowance is the credits a new workspace starts with once its owner is
verified. A model subscription's quota (订阅额度) is the subscription owner's,
never the workspace's.
_Owner_: the workspace (Billing aggregate); 订阅额度 belongs to the account.
_Avoid_: bare 额度 (say 免费额度 or 订阅额度), balance, quota for credits.
