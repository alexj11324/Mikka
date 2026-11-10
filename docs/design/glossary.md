# Glossary: bot, thread, chat

This file is the single definition of these words. Specs, designs, issues and
code comments use them in this sense. Follow the source order in [the design entry point](README.md) when a
newer accepted decision changes a definition here.

Decided by Alex, 2026-10-24.

## The three things

| Word | 中文 | What it is | Where it shows | Its name |
| --- | --- | --- | --- | --- |
| **Bot** | Bot | Chats with people. Does web tasks itself through sub-agents (分身, R-72), each with its own browser, and dispatches real tasks such as coding to threads. The user creates it (Grok Bot style) and can put several bots in a group chat. The Coordinator is a bot too. Stored in its own `bots` table (name, colour, shape) and runs on Mikka's own AI SDK on Vercel; it is not a row in `agents`. | **Bot list** (left column), one row per bot or group chat. | The bot's own name, e.g. "Mikka Frontend". |
| **Chat** | 对话 | The conversation between a person and the selected bot or group chat. | **Center column**. Header pill = the bot's (or group's) name. | Same as the bot or group. It has no name of its own. |
| **Thread** | 线程 | Does the work a bot dispatched: a run chain, identified by its root run (`rootRunId`), made of that run and every run that resumes, retries or continues it (`lib/run-chain.ts`; each is a row in `agent_runs`), usually tied to a task. A bot can dispatch many threads at once; it never runs, owns or does a thread. | Inside its task, in the task conversation and its attempts. Task lists occupy the right column. | Its own name, about the work, e.g. "#66 群聊前端骨架" or "MIK-11 群聊建表". Never the bot's name. |

How they connect: a person chats with a bot (center). The bot dispatches
real tasks such as coding to threads, which do the work (right). A web task
stays with the bot: one of its sub-agents (分身) does it in its own browser,
it shows only as a card in the chat, outside the task lists, and the bot
reports the result itself (R-72). A thread is run by an Agent (Claude Code,
Codex). A bot never runs, owns or does a thread; it only dispatches it, and
the UI says 「<Bot> 派出的线程」 or 「<Bot> 派出」, never 「<Bot> 的线程」 or
「所属 Bot」. A thread is never drawn with the bot's avatar. Task rows show the task's own
state icon, and attempts show their result icon. The Agent's mark identifies
the coding Agent where it is named (R-52, R-74, R-78). A bot does no coding
work itself: an Agent (Claude Code, Codex) runs every thread. A cloud thread runs on its own thread machine,
not on the dispatching bot's machine (`cloud-computer-backend.md` § 2).

## Workspaces

| Word | 中文 | What it is |
| --- | --- | --- |
| **Account** | 账号 | The person: 账户, security, 偏好, 通知, profile memory (个人资料类记忆), 密钥与登录, 设备 and 「模型与订阅」. The same in every workspace. |
| **Personal workspace** | 个人工作区 | One per person. Only that person's bots, chats, tasks, threads and their memory; personal 计费 and 用量; no team settings. |
| **Shared workspace** | 共享工作区 | Members, 团队权限, 密钥与环境, 审计日志, team 用量 and 计费. Nothing moves between it and a personal workspace. |
| **Organization** | 组织 | Manages membership, organization connections, policies and billing across attached Workspaces. Each Workspace remains an independent tenant; an Organization role does not confer private content access. |
| **Resource owner** | 所有者 | Manages a Project, Task, Thread, Bot or Artifact's access and controlled ownership transfer. Ownership does not bypass a private ancestor or a revoked Workspace membership. |
| **Actor** | 操作者 | The authenticated person or service principal responsible for a message or operation. Kept separately from the Thread Owner, execution identity, credential owner and payer. |

Decision: [2026-11-01-2310](decisions/2026-11-01-2310-personal-and-team-workspaces-apart.md).
Collaboration and financial authority: [2026-11-10-0017](decisions/2026-11-10-0017-collaboration-governance.md).

## Rules for designs

- The left column is the **bot list**. In the hosted shell a Bot expands
  its dispatched tasks and Agent work below its own row, like Capy's Captains
  ([2026-11-10](decisions/2026-11-10-1317-capy-sidebar-and-task-layout.md)).
  Bot and group rows keep their own avatars. A child is named for its work;
  a task carries its own state, and the Agent's mark identifies its executor.
  This navigation does not change the distinction between dispatching Bot,
  task and executing Agent.
- Task lists continue to show one row per task, with its threads inside
  ([2026-11-07](decisions/2026-11-07-2045-tasks-only-threads-inside.md)).
  A standalone Agent run already visible to its dispatching Bot can be a
  child of that Bot in the hosted sidebar; it is not a global thread list.
- The right panel's 概览 header is the selected bot (the same avatar and
  name as its left row), followed by the tabs 详情 / 任务 / PR / 电脑. A
  task's title appears in its task row and detail, never as that
  bot header (Alex, 2026-10-28; `rules.md` R-02, R-50).
- Choosing another bot on the left changes the center chat and the right
  column's dispatched tasks and computer together.
- A task (issue, `MIK-xx`) is one conversation: its runs read oldest first,
  and where the Agent changes, a label with the next Agent's mark and name,
  never a 「换」 verb (as Warp labels runs). The composer addresses the
  newest run ([decision](decisions/2026-11-09-0045-no-attempt-word.md)).
- **Attempt** is an internal data term only (`factory_attempts`, a run chain's
  runs). User-facing copy never says 「尝试」 or "attempt".

## Run result (运行结果)

How one run came out, in one set of words on every surface that shows it: the
task page's 活动 rows, the right column's 活动 rows and the task conversation
(`hooks/use-run-result.ts`), and iOS (`MobileCore.attempts`). A 活动 row shows
the result of its Agent stretch's latest run. It is the run's own result, never
the task's status: task status, Factory stage, run result and the derived
受阻 / 等你处理 are four different things (#1687).

| Result | 中文 | English | When |
| --- | --- | --- | --- |
| running | 运行中 | Running | The run is working. |
| queued | 排队中 | Queued | The run waits for a machine. |
| waiting | 等你回复 | Needs your reply | The run waits on the person; its reason may say more (等你确认, 待审阅). |
| done | 完成 | Done | The run finished its work. |
| failed | 失败 | Failed | The run failed. |
| blocked | 受阻 | Blocked | The run stopped on something it cannot fix itself, such as 额度用完. |
| idle | 暂不处理 | On hold | The run decided there is nothing to do now. |
| ended | 已结束 | Ended | An earlier run left waiting while the conversation went on. |

_Avoid_: 「换 Codex」 or 「换 Codex 继续」 (a row or a change of Agent is labelled by the
Agent's own mark and name), 已解决 for a run (a thread group word, R-52), 已替换, 进行中 for a run
(进行中 is the board column), 尝试.

## Other words

Decided by Alex, 2026-10-28.

| Word | 中文 | What it is |
| --- | --- | --- |
| **Artifact** | Artifact | Something a thread produces for the person to look at or accept, such as an acceptance (验收), a PR, a document or a web page. The word is never translated (not 产物, 工件 or 成果). Lives on the Artifact rail page (R-56). An open thread's header always has an Artifact button, and the message that finishes a thread carries its Artifact card (Alex, 2026-11-06). |
| **Agent** | Agent | The coding agent that runs a thread: Claude Code, Codex, Cursor (`agents` table, a harness). It does the coding work; a bot never does. Shown by its own brand mark wherever a thread or run has an icon (R-78). Never called harness or 执行器 in the UI (R-43). |
| **Agent Profile** | Agent 配置 | A reusable logical coding role owned by a person in a workspace: responsibilities, capabilities, Agent/model policy, effort, private instructions and controlled Skills. Several Profiles may use the same physical Agent/model. Managed in Settings › Models and subscriptions; frozen into each selected run. Has its own mark (a glyph and colour), the main mark of its Agent stretches (R-78). It never becomes a Bot or a left-column row. [Spec](factory-agent-profiles.md). |
| **Library** | 资料库 | A bot's files, listed under 概览 › 详情; the person can delete their own (R-51). Files are added with the composer's 「+」. |
| **Thread** | 线程 | As above. Since 2026-11-07 it is shown only inside its task (an Agent stretch in the task's 活动); no list or tab is named 线程. |
| **Browser** | 浏览器 | The person's own local browser, one for the whole app, opened from the globe in the top bar (R-57). |
| **Computer** | 电脑 | A bot's cloud computer: its own desktop (X display) on its owner's bot machine, which is one per person per workspace (`cloud_machines` keyed by `workspaceId`, `ownerId`; `bot_desktops` keyed by `botId`). Used by that bot only; a thread that needs a desktop gets its own machine ([0251](decisions/2026-11-02-0251-desktop-runs-get-their-own-machine.md)). Shown in the 电脑 tab of 概览 (R-50). Never called 浏览器. |
| **Bot machine** | Bot 机器 | The E2B sandbox that hosts one person's bot desktops in a workspace. One per person per workspace, not one per bot. |
| **Thread machine** | thread 机器 | The E2B sandbox one cloud thread runs on, from the verified official-derived template. Separate from the bot machine. |
| **Workspace policy** | 工作区策略 | Target contract (Capy parity): the only authorization surface — MCP servers (allow / read-only / disabled), devices (allow), computer use (allow / deny). Never per Bot. Current builds still carry per-Bot rows until the workspace rule lands. |

## Words to avoid

- "会话" / "session" / "conversation list" for the left column. The left
  column is the **bot list** and the right column is the **task list**.
- "会话" for a run (e.g. "打开会话" on a task's run). Say **线程**.
- 「线程」 as the name of a list or tab. Lists hold tasks (2026-11-07); the right panel's tab is **任务**.
- A Chinese word for Artifact. Keep **Artifact**.
- "浏览器" for a bot's cloud computer, or "电脑" for the local browser.
- "Agent" when you mean the thing on the left. Say **bot**. **Agent** is the
  right-side worker that runs threads (`agents` table, Claude Code, Codex).
- "harness" or 「执行器」 in the UI for that worker. Say **Agent** (R-43).
- 「E2B」 as the cloud machine's name. It is **Mikka Cloud** in both languages,
  never translated; E2B names only the provider and its API key.
  Code identifiers may keep `harness`.
- 「Bot 的线程」, 「所属 Bot」, "bot's threads", "a bot's thread" or "the thread
  belongs to a bot". A bot only dispatches threads; an Agent runs them. Say
  「<Bot> 派出的线程」 / 「<Bot> 派出」, "threads a bot dispatched".
- 「Mikka Cloud」 for the hosted model, or 「Mikka 默认」 for the cloud machine.
  Mikka 默认 is a model, Mikka Cloud is a machine ([orchestration](orchestration.md) § 1).

## Domain terms: tenancy and ownership

Who owns what, in the format of the domain-modeling skill's glossary
(`mattpocock_skills` `GLOSSARY-FORMAT.md`). Each term names the aggregate it
belongs to (DDD: the consistency boundary that owns it). Where a line below
and the Workspaces table above differ about 密钥与环境, the line below follows
[2026-11-02-0231](decisions/2026-11-02-0231-workspace-is-the-tenant.md), which
records the workspace tenancy rules. Bounded contexts, aggregates and the code that
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

**Shared workspace (共享工作区)**:
A workspace with more than one possible member. Only it has what is between
people: members, teams, roles and team permissions, member audit, shared
credits and seats, transfer.
_Owner_: its owner account; administered by its admins (Workspace aggregate).
_Avoid_: 团队工作区 and 团队 on its own (a 团队 is only a group inside a workspace), organization.
_Note_: target term (decision D11 of the coordinating session, 2026-11-02). The UI
now says 共享工作区 / shared workspace (2026-11-08); code still says `team` for it until the rename in Known naming debt.

**Team (团队)**:
A named group of members inside a shared workspace, with its own task prefix,
tasks and projects (as a Linear team).
_Owner_: the shared workspace (Team aggregate).
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
(模型与订阅).
_Owner_: the account (Agent aggregate).
_Avoid_: harness, 执行器, bot.

**Thread (线程)**:
As defined above: one piece of work a bot dispatched, run by an Agent. The
bot only dispatches it; it does not own or run it.
_Owner_: the workspace where it was dispatched (Thread aggregate).
_Avoid_: 会话, session, 任务, run (a run is one turn of a thread).

**Task (任务)**:
A unit of work to be done, with a status and an assignee who is always a
person (`MIK-xx`). A thread works on it; it is not a thread.
_Owner_: the workspace; in a shared workspace, its team (Task aggregate).
_Avoid_: issue in the UI, ticket, 工单, thread.
_Note_: 受阻 (Blocked) is a board column a task falls into while its newest
thread, a task it is blocked by or the person's flag stops it; it is not one of
the task's statuses ([2026-11-06-1600](decisions/2026-11-06-1600-blocked-board-column.md)).

### Resources

**Device (设备)**:
A computer or server of the person's that runs their Agents through the
desktop app or the daemon. Not a bot's cloud computer (电脑).
_Owner_: the account (Device aggregate).
_Avoid_: 电脑 (a bot's cloud computer), machine in the UI, runner.

**Daemon (daemon)**:
The background service on a device that connects it to Mikka and runs its
Agents. The UI calls it daemon in both languages, with no 「Mikka」 in front:
「重启 daemon」, "Update daemon". Not the Mikka desktop app.
_Avoid_: Mikka 客户端, Mikka client, 客户端 (reads as the desktop app).

**Connection (连接)**:
An authorized link to an outside provider. Personal app connections (Gmail,
GitHub, Linear, Telegram…) and Claude Code/Codex subscriptions belong to the
account. Organization model connections are API keys, gateways or custom
endpoints owned by the organization. Sharing content never shares a connection.
_Owner_: the account or organization (Connection aggregate); a Subscription
connection is always account-owned and never a public member resource pool.
_Avoid_: integration, plugin (a 插件 is the store item, the connection is
what linking it creates), binding.

**Secret (密钥)**:
A named value authorized for work in one workspace, or one repository in it.
Sensitive third-party API values follow the scoped capability boundary in
[decision 2026-11-08-0240](decisions/2026-11-08-0240-credential-exposure-boundary.md).
`lib/secrets/runtime.ts` separates ordinary env and explicit direct delivery
from protected HTTP capabilities, which the claim route seals for the run.
Deployed protection requires the decision's runtime canaries and evidence.
_Owner_: the account for Personal secrets, or the Workspace/Project for Shared
secrets. Thread scope narrows delivery to authorized work; it does not change
ownership or authorize delivery of someone else's Personal secret.
_Avoid_: credential (a model credential is the account's), token, 环境变量 as
a separate thing (an environment variable is a kind of secret).

**Credits (点数) and free allowance (免费额度)**:
Credits are what a workspace spends on Mikka 默认 and pays for; the free
allowance is the credits a new workspace starts with once its owner is
verified. A model subscription's quota (订阅额度) is the subscription owner's,
never the workspace's.
_Owner_: the workspace (Billing aggregate); 订阅额度 belongs to the account.
An Organization can explicitly designate an attached Workspace's existing
billing account for its platform resources. Existing balances keep their
owner and ledger history. External API keys, subscriptions and E2B bills remain
external; an unavailable provider amount is **Unknown**, never zero.
_Avoid_: bare 额度 (say 免费额度 or 订阅额度), balance, quota for credits.
## Known naming debt

Code names that disagree with this file. They stay for now (no large rename,
2026-11-02). Whoever next changes the related code renames it in that PR,
with a migration for database names, and deletes the row here. Until then
read the code name in the sense given below.

| Term in code | Current meaning(s) (where) | Target | Note |
| --- | --- | --- | --- |
| `coordinator` (tables, `lib/coordinator/*`, `CoordinatorChat`) | Any bot's chat, not only the Coordinator bot: `coordinator_sessions`, `coordinator_messages`, `coordinator_events` (`lib/db/schema.ts`), `lib/coordinator/*`, `components/coordinator/coordinator-chat.tsx`. | **Bot chat**: `bot_chat_*` tables, `lib/bot-chat/*`. | Tables need a migration. Keep `coordinator` only for the Coordinator bot itself. |
| `agent` | Three things: an `agents` row is a harness configuration and subscription-consumer identity registered against a device (`lib/db/schema.ts`, `lib/device-agents.ts`); the Agent brand (Claude Code, Codex), stored as `harness`; and a group-chat member/author type `'agent'` plus `conversations.leadAgentId` (`lib/db/schema.ts`, `lib/group-conversations-store.ts`). A cloud task's actual execution device is `agent_runs.deviceId`, proved by that run's owner-bound `computer_run_bindings` and `thread_machines`; host placement can differ from the configuration's registered device. | Agent configuration identity for the row; the run and its machine binding for execution placement; `harness` for the brand; **bot** for the group-chat member, author and lead. | Local execution retains the registered-device check. Cloud placement retains the exact owner, workspace, bot, issue, device and repository checks. The UI word **Agent** above is unchanged: the coding Agent runs on the thread machine, and the bot only dispatches. |
| 团队 / `teams` | Both a team workspace (`workspaces.kind = 'team'`, `lib/db/workspace-schema.ts`) and a sub-team inside a workspace (`mikka_teams`, `lib/db/team-schema.ts`). | **Team** (团队, `mikka_teams`) is only the sub-team inside a workspace, matching Linear's Team, since tasks sync to Linear. The team workspace becomes **shared workspace** (共享工作区) in code and copy, opposite **personal workspace**. | Copy renamed 2026-11-08 (UI audit gap-12); code names (`workspaces.kind = 'team'`) still to rename. |
| `issues.scope` `'personal'` / `'workspace'` | Linear-sync visibility of an issue (`lib/db/schema.ts`), not the personal workspace. | `'unsynced'` (not synced to Linear) for `'personal'`. | Collides with **Personal workspace**. Renaming needs a migration. |
| `factory_tasks` | A factory job, not a task (`lib/db/schema.ts`). | `factory_jobs`. | "Task" means only an issue (`MIK-xx`); `TaskDetail` (`components/workspace/task-detail.tsx`) loads a task and keeps its name. |
| Chat key | One chat, three encodings: `conversation_reads` id `'coordinator'` or `'bot:<uuid>'` (`lib/conversation-reads-store.ts`); `chat_preferences.chatKey` = raw bot id; `bot_model_choices.botKey` = bot id or `'coordinator'` (`lib/model-api-keys.ts`). | One `chatKey(botId)` format. | Remove the `'coordinator'` sentinel with a migration. |
| `agentName` on a run | The name of the bot that dispatched the run, not an Agent's (`lib/agent-runs.ts:59`, from `runBotName` in `lib/run-bot-name.ts`). | `botName`. | Code unchanged for now (2026-11-02). Read it as the dispatching bot. |
| `session` | Six things: `coordinator_sessions` (bot chat state); `agent_sessions` (old chat archive); `agent_runs.sessionId` and `factory_attempts.sessionId` (the harness CLI session); `session_mailboxes` (`lib/session-mailbox.ts`); `browser_sessions` (`lib/credentials/store.ts`); and sign-in in `lib/session.ts`. | `harnessSessionId` for the CLI session field; bot chat for `coordinator_sessions` (row 1). Others keep their names. | UI never says 会话 for any of them (see above). |
