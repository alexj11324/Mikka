# Design rules

These are decisions Alex has already made. Designs, specs and code follow
them without asking again. To change a rule, Alex decides, the change is
logged in [`decisions.md`](decisions.md), and this file is edited in the same
PR. Cite rules by id in reviews ("breaks R-11").

Words (bot, chat, thread) are defined in [`glossary.md`](glossary.md). Which
source wins in a conflict is in [`README.md`](README.md).

## Bots, chats and threads

- **R-01** The left column is the bot list (bots and group chats). The right
  column is 概览 with its tabs, the thread list (线程) being one of them, or
  全部线程 (R-50). There is no "conversation list".
- **R-02** The right panel's 概览 header shows the bot selected on the left:
  the same bloub avatar and the same name as its left row, then the tabs
  详情 / 线程 / PR / 电脑 (R-50). A thread's name appears only as a row in a
  thread list, never as that header.
- **R-03** Choosing another bot on the left switches the centre chat, the
  right threads and the computer together.
- **R-04** Every bot comes with its own computer. There is no 新建云端电脑 entry
  anywhere, and no list of per-bot computers.
- **R-05** 「Bot 本身走我们自己的 AI SDK，跑在 Vercel 上。Bot 需要干活时，通过
  daemon 把任务派给 Claude Code 或 Codex。」 (Alex, 2026-11-01;
  [orchestration.md §3](orchestration.md)). GPT/OpenAI models go to Codex,
  every other model to Claude Code; a person can change this per model in
  「API 与订阅」. The 新建 Bot dialog has a big live preview, a shape grid,
  colours and a name. It has no machine picker, no Claude Code / Codex picker
  and no 说明 field (instructions are edited in chat). A bot's own chat never
  runs inside Claude Code or Codex: that was an old plan (#312), abandoned.
- **R-06** The Coordinator has no special UI; it is a normal bot (Alex
  2026-10-24). Its role is coordinating, not looking different: the same
  bloub avatar with no badge of its own, the same row, the same chat, the
  same empty state as any other bot. Never the letter C. 星标 = 置顶标记，所有
  bot 一致: every pinned bot shows the star, the Coordinator only when pinned,
  like any other bot (Alex 2026-11-01).
- **R-07** Action entry points (buttons, menu items, the collapsed sidebar
  toggle, the 新建任务 dialog header) never say "Coordinator". Conversation
  headers keep the centred Coordinator pill.

## Chat

- **R-10** An input box goes only where there is a conversation, and it is
  always the same composer (the Coordinator chat's: Grok style, attachment
  button). Views that are not a conversation never get one: the thread list
  and a bot's computer screen send instructions through the centre composer.
  An open thread is a conversation with the agent running it, so its detail
  ends in that composer and what is typed there goes to that agent.
- **R-11** A bot's composer, the Coordinator's included, has one model chip
  (`BotModelPicker`) beside 「+」, saved per bot; it picks a model only, never
  an Agent. Settings has no per-bot model rows
  ([decision](decisions/2026-10-31-2330-bot-model-picker.md)). A thread's
  composer has none.
- **R-12** No starter or suggestion cards in any chat ("试试从这些事情开始").
  Suggestions live only on the 建议 page (R-55). A new bot greets with one
  bubble and an A–D choice card.
- **R-13** One-to-one chats (a bot, the Coordinator, the 建议 page's
  Coordinator chat, the board's Coordinator sidebar) show no avatar or name on
  messages; the header pill names the bot.
  Group chats show a 24px avatar on the left of the bubbles at the bottom of
  each run and the name once per run, 12px Medium in the bot's colour (Figma
  `224:5023`). A group's 详情 is about people, not computers: the group
  avatar and name, then its members (people and bots), recent threads and
  files. No cloud computer in a group; open a bot's own chat to see its.
- **R-14** The user's messages sit in an accent-blue bubble with white text
  (`accent/default`); a bot's text sits in the light grey bubble. Charts,
  OpenUI cards and choice cards have no bubble. Bordered cards (document,
  computer, Artifact) sit below the text bubble, never inside it. A 建议 card
  the user taps is their message but keeps its card shape, no blue bubble; the
  instruction under it is a blue bubble (R-55). This holds in every one-to-one
  chat, the board's Coordinator sidebar and the AI sidebar included.
- **R-15** A task or thread mentioned in chat is an inline chip, not a large
  card (a task chip carries the board's status icon). Internal object chips
  are boxed: a faint accent fill (`--object-chip`), small radius, the status or
  type icon, then the title in the accent with no underline; the chip never
  breaks across lines and a long title truncates. The task number is in the
  hover card, not the chip. A thread chip leads with the thread's status icon
  (the same marks and colours as the thread card and Threads list) and opens
  the thread's own conversation, as a thread card does (R-66); only a task chip
  opens the task. Web sources and links keep the unboxed source chip (R-14). A thread the reply
  dispatches is different: it is a thread card under that reply (R-66). An
  Artifact waiting for acceptance is a bordered card under the reply (icon,
  name, state such as 待你确认); clicking it opens the Artifact window (R-56).
- **R-16** The computer card in chat shows a title, a status, one sentence
  about the task and a big screen. It has no approval step: the bot operates
  until the person takes control (decisions 2026-10-30). It never shows an
  operation log, a step checklist, or OS and spec lines.
- **R-17** The 概览 header does not show 「<Bot 名> 的屏幕」. The 电脑 tab
  holds the bot's screen, the existing `AgentComputer` view (R-50).

## Suggestions, tasks and devices

- **R-20** Notifications from connected apps' webhooks (Gmail, Notion,
  Slack, GitHub, Linear…) are rated by the decision model (OpenAI Decisions
  API) after Comma's attention model: first the cost if the person does
  nothing, when it lands and whether it can be undone; then one level,
  critical, high, ask, normal or low (unclear rereads the source), and
  whether the Coordinator takes it up now. The level's guidance (any cost is
  at least high; a cost due within 48 hours, or an irreversible one due within
  a week, is critical) is in the question; no code floor, cutoff or rule before
  the call changes the answer (decision 2026-11-01-1300). Only the Coordinator speaks to the person about events: no
  push, chat message or Telegram/Slack message is sent around it. What the
  model says to take up goes to the Coordinator at once. The daily briefing is posted
  by the Coordinator in its chat every day at 08:00 local time (and pushed),
  whatever the bar below says. It tells the person only when they must act before the next
  08:00 briefing, or when a cost that cannot be undone lands within a week;
  everything else waits in 建议 for the briefing. When unsure, it stays
  quiet. It also stays quiet when fresh evidence shows the matter resolved,
  owned by someone else, or already covered in the chat. When the Decisions
  API says not now, a matter the person must still act on is snoozed until
  the time it names, never dropped. Telling the person is a card in its
  own chat that says what happens if nothing is done and offers one next
  step, pushed on mobile. Normal stays in 建议; low is not shown. Whether to
  interrupt the person now, which waiting matter the Coordinator takes up
  next, and what happens to a matter it left undecided are Decisions API
  answers that read how often the person was told today; only runaway caps
  (24 tellings, 48 handoffs a day) stay in code. Held items wait, they are not
  dropped. The Coordinator never
  acts on an event before the person says yes. Its own ideas also go in its
  chat.
- **R-21** 建议 is its own rail page (R-55), not part of the right panel; the
  panel's old 任务 section is the 线程 tab (R-50). 建议 is the normal-level
  items in one list, newest first, each row with its app's icon (no per-app
  cards). The daily briefing is not in 建议; it is the Coordinator's 08:00 message, also
  sent right after the person connects an app. A thread started by the
  orchestrator or a bot stays listed in the thread lists (R-52); they are not
  a flat list of the board's issues. 建议 items are standalone cards, each one
  sentence: a verb chip, the app's icon inline, the concrete thing and its
  reason, deadline or amount
  (「取消你的 Verizon 套餐，赶在 11 月 1 日自动扣款 $52.13 之前」); no
  separate meta line. Tapping posts the same card in the Coordinator chat
  beside it followed by the full instruction handed to the orchestrator,
  written with its background (account, source, what to check, and to stop for
  confirmation before an irreversible step). While it runs, the card shows a
  progressive verb (正在取消). The flow: the person says yes to a Coordinator
  card, or taps a 建议 card, which starts the task at once (no composer step) →
  the orchestrator runs it as a bot sub-agent (web, R-72) or dispatches a
  thread (a real task such as coding) → the card shows it running and leaves
  建议 when done; a thread also shows up in the thread lists.
- **R-22** Tasks are never created on the board itself: no column `+`, no
  status pick. The 新建任务 button, ⌘K and `c` open one dialog where the user
  describes the task in a sentence and the Coordinator writes it. The dialog
  shows a machine picker.
- **R-23** Machine picker order: **Mikka Cloud** first and selected by
  default; then the group **本机** (this Mac, a local Linux machine); then the
  group **Remote control** (VPS and SSH hosts reached through the user's
  machine). Settings › 设备 uses the same two groups.
- **R-24** A device's online state is a StatusDot on the top-right of its
  icon (green online, grey offline, red error), never a text badge.
- **R-25** Board cards follow Figma 「看板卡片 v1」 (`714:5283`): a filled card
  with no stroke (R-31), radius 8px, padding 12px, rows 8px apart, icons
  14px. Row 1 is the id, a lock when the task is personal, and the assignee
  avatar group on the right (never a name; nothing when unassigned). When a
  Bot owns the task its avatar is on top. Row 2 is the status icon and the
  title, at most two lines, then an ellipsis. Row 3 shows only what the task
  has, in this order, wrapping when needed: priority, labels (bare dot and
  text, at most two, then 「+N」), the newest PR (then 「+N」), subtasks, the
  latest run's state and the due date. Only the run state is a tinted pill
  (运行中, 等你处理, 运行失败). Colour carries meaning only: a failed run and an
  overdue date are red; run state, urgent priority and PR state are green or
  orange; a done card's title is the secondary grey. The board is the reUI
  Kanban with no column `+` (R-22) and no page-title pill (the rail says
  where you are). Columns are a fixed 300px, as in Linear: when they do not
  fit, the board scrolls horizontally, and spare width stays empty. With the
  Coordinator sidebar open every column, 已完成 included, keeps its 300px;
  no column folds to a strip
  ([decision](decisions/2026-11-01-1144-board-done-keeps-its-width.md)). Figma: page 「看板卡片 v1 · 定稿 2026-10-31」
  (`714:5283`).
- **R-26** Workspace tasks sync with Linear (`MIK-xx`); personal tasks stay in
  Mikka. A task can move both ways: a workspace task can be turned back into
  a personal one (its Linear issue is archived; issue #184). Teammates see agent runs on workspace issues only, never left-column
  chats or private memory.

## Issue detail

Linear is the reference for the issue page; when this section is silent,
do what Linear does. Figma: `220:5022` (MIK-25).

- **R-60** The assignee is always a person. Handing the issue to a bot shows
  the bot on its own line under the assignee, joined by an elbow line, and
  the activity records 「<人> 把任务交给 <Bot>，自己负责」 (Linear's delegate).
- **R-61** The page has a header line under the breadcrumb and one vertical
  line before the properties column or an open thread. Nothing else gets a
  line; sections are separated by space. The content column is centred in
  the main area, up to 680px wide.
- **R-79** No breadcrumb, title bar or page header shows the workspace's
  name. There is one workspace on screen, the name cannot be clicked there,
  and it is shown and switched only from the avatar menu at the bottom left.
  The task page's breadcrumb starts at 看板. A group heading that names the
  workspace its settings apply to (设置's workspace group) is not a crumb and
  stays.
- **R-62** 线程 lists the threads working on the issue, grouped as R-52:
  status icon (never the bot's avatar, `glossary.md`), thread name, time, and
  the opening of its last reply (R-53). Someone who cannot open the thread
  sees no reply line. Clicking one opens it on
  the right as a conversation that ends in the composer (R-10); people and
  the agent talk there. A thread's content is its owner's alone: teammates
  (R-26) see 「<人> 的线程」, its status and time, and cannot open or join it,
  as GitHub Copilot and Cursor keep agent sessions private; what the thread
  produces (a PR, a comment its owner posts) is how the team sees the work. The bot dispatches the thread; the Agent it hands the work
  to (Codex, Claude Code) runs it, and where a thread carries an icon
  other than its status, that icon is the Agent's mark (R-78).
- **R-63** Activity: events (created, handed to, dispatched a thread,
  status changes) are plain one-line rows; one person's events in the same
  minute join into one row (「创建了任务，交给 Mikka Backend，自己负责」). A comment is a card with a 1px
  border; its replies sit inside the same card above a 「留下回复…」 row. The
  comment box at the bottom is the same bordered card.
- **R-64** In a comment you can @ a person or a bot. @ a bot asks it to step
  in; it may dispatch a thread. You never @ a thread: open the thread and
  talk there.

- **R-65** Every page that is not a conversation (board, issue, project…)
  has the same AI sidebar button at the top right (⌘J; tooltip 「AI 助手」,
  never "Coordinator", R-07). It opens a conversation with the Coordinator
  by default; its name in the sidebar header switches to another bot, and
  the choice is remembered. The page's subject (the open issue) comes along
  as a removable context chip above the composer. On the issue page it takes
  the right column, as an open thread does; closing it brings the properties
  back. The home page is already that conversation and has no button.
  Figma: page 「AI 侧栏 · 全局」.
- **R-66** When the Coordinator dispatches a thread, the chat shows one
  thread card under its reply: status icon (never the bot's avatar), thread
  name, then its outputs as chips such as a PR, folding extras into +N. No
  step or progress line under the name (Alex, 2026-10-27). The card updates in place, so a thread has one
  card in a chat; a later change of state is a sentence from the Coordinator,
  not a second card. The card has no log, input box or buttons. Clicking it
  opens the thread conversation: on desktop the centre column switches to it
  with 「‹ Coordinator」 to go back, on a phone it pushes in full screen.
  Figma: page 「线程卡片 · 聊天里派出线程」.
- **R-81** A task has one thread at a time (Alex, 2026-11-01). Dispatching a
  task that already has a thread gives that thread the work: while it works
  the note goes in as a message; once it ended (done, failed, stopped) it runs
  again in the same thread, resuming the agent's session where it can. The
  thread's id does not change. Only the person's explicit request for a new
  session or thread, or another agent, starts a new one; the old thread is
  stopped and marked replaced. The server enforces this at every dispatch
  entry, not the prompt ([decision](decisions/2026-11-01-1330-one-thread-per-task.md)).
  The person may name where it runs (one of their computers, or the cloud);
  a named computer that is offline gets the 没有可用的电脑 card, never another
  computer, and the reply names only where the run actually is.

## Right panel, 建议, Artifact and browser

Figma: page `395:15023`, frames F1–F10 (listed in `decisions.md`).

- **R-50** The right panel is the right third of the window. Its header has
  two pills on the left, 「概览」 (selected by default) and 「全部线程」, and
  search, widen and close icons on the right. The pills switch only this
  column; the centre chat is never removed or replaced. 概览 is the selected
  bot's avatar and name (R-02), then the tabs 详情, 线程, PR, 电脑. 线程
  lists only the threads this bot dispatched (for the Coordinator, the
  threads it dispatched); 电脑 is the bot's cloud computer (`AgentComputer`).
  全部线程 lists every bot's threads; each row carries the small mark of the
  Agent running it (R-78), the only thread list that shows one, beside a
  relative time on the right (2 分钟前, 昨天).
- **R-51** The right panel is read-only. No action buttons anywhere in it (no
  让它安排, 新建, 上传 or arrange). Besides navigation (the pills, the tabs, the
  header's search, widen and close, and a list group's collapse chevron), the only
  controls are 「展开」 to expand a list and, in a bot's 概览 header, its own name
  and avatar: clicking the name renames it in place (Enter or leaving saves, Esc
  cancels) and clicking the avatar opens the 新建 Bot shape and colour picker
  (2026-10-31). The Coordinator's header stays read-only. 详情 holds two lists, 例行 (routines)
  and 资料库 (library). The bot creates routines when asked in chat; files are
  uploaded with the composer's 「+」.
- **R-52** Every thread list, web and phone, groups its rows in this order:
  进行中（N）, 受阻（N）, 等待你（N）, 空闲（N）, 已解决（N）
  (Running, Blocked, Waiting for you, Idle, Resolved). A group header is
  muted text (「等待你（2）」) followed by a thin rule filling the rest of
  the row. 已解决 is collapsed by default behind a chevron. Never a 「今天」
  or 「今天完成」 group
  ([decision](decisions/2026-11-01-1250-five-thread-groups.md)).
  - 进行中 follows the run's state: queued, preparing, running or finishing.
  - Every other group follows how the run came out (`agent_runs.outcome`:
    done, blocked, needs_input, failed, idle), judged by the decision model
    when the run ends from its last reply, status, task and PRs
    (`lib/run-outcome-judge.ts`); with no answer it stays empty and is asked
    again an hour later. Code never guesses it from the status: a run that
    "finished" saying it could not log in is 受阻.
  - 受阻: blocked or failed, or paused on its quota: it needs something
    outside the work fixed (login, credentials, proxy, permission) or nobody
    took over after it failed. 等待你: needs_input, a run asking a question,
    or a task with a PR to review. 空闲: idle, its task still open.
  - 已解决 only when the outcome is done, or its task is done, cancelled or a
    duplicate, or its PR is merged. A run nobody could judge sits under 受阻
    (failed) or 等待你, never 已解决.
  - Every row leads with its group's status icon and colour, the phone's set
    (`ThreadStatusIcon`): 进行中 spins, 受阻 a red alert, 等待你 a hollow
    circle, 空闲 a slashed circle, 已解决 a green check.
  - A task's existing threads fold into its newest one, which carries
    「第 N 次尝试」 past the first and stays out of 已解决 until the task is
    resolved; the task's own 线程 tab lists every attempt. (New work keeps one
    thread per task, so this is for threads that already exist.)
- **R-53** A thread row has two lines: the thread's title, then the opening of
  its last reply quoted verbatim, cut to one line. No generated description,
  no status word and no bot-name prefix (generating them costs compute).
- **R-54** The PR tab lists the PRs of the threads this bot dispatched, in groups 等待审查, 进行中, 已合并,
  with R-52's header style. Each row is the PR title and its number.
- **R-55** 建议 is the second rail item. Its page is split 50/50 with a 1px
  divider: on the left the title 「建议」 (24px SemiBold) with a refresh icon,
  then one column of mobile-style cards (R-21: verb chip, source mark, inline
  brand mention chips); on the right the Coordinator chat, flush. Clicking a
  card posts the identical card (same shape, same chips) into that chat as
  the user's message (Hark), followed by the full instruction; the
  Coordinator then handles it as R-21 says (a sub-agent for a web task, a
  thread for a real one). The cards follow these taste rules: border or
  shadow, never both; radius 16 (F8); one left/right edge; inline icons
  12–14px; accent only on data or on one control.
- **R-56** Artifact is the fifth rail item, with Mikka's own icon: two
  upright rounded cards, slightly tilted, the front one bottom-left, the back
  one top-right showing only its top and right edges (Figma `icon/artifact`).
  The Artifact page has a category list on the left (全部, 验收, 文档, 网页 …)
  and a table on the right: 名称, 状态, 来源, 上次活动. A thread page's header
  has an 「Artifact · N」 entry. Opening an Artifact shows a window with the
  acceptance content on the left (PR, checks, screenshots and recordings),
  the thread's chat on the right, and 打回 / 通过 at the top.
  Factory acceptance is different: it is the 「验收」 tab of the thread that
  produced the candidate (header 对话 | 验收; Figma `358:8511`), with the
  decision bar pinned at its bottom (`decisions.md`, 2026-10-30).
- **R-57** The local 浏览器 is an icon-only globe toggle at the right of the
  top bar, with no 「浏览器」 label. Turned on, it opens a right column with
  the browser (URL bar and page). Selecting an element and annotating it puts
  a chip 「1 · <element> · <action> · <note>」 into the current chat's
  composer. The 浏览器 is the person's own and app-wide; it is not a bot's
  电脑 (R-50).

## Settings

- **R-70** Every setting needs a precedent. A row on any Settings screen
  (web or mobile) ships only if a comparable product (ChatGPT, Claude,
  Comma, Hark, Wabi, Linear, GitHub, Slack and the like) has the same setting;
  the spec cites the product and source for each row. No precedent, no row.
  Settings are a hierarchy: the top screen holds a few categories, and each
  opens its own page; rows are never laid out flat on one page. A row never
  states what the person already knows (for example which provider they
  signed in with).
- **R-71** Icons follow precedent too: each icon is the one mainstream
  products use for the same function (memory = book as in ChatGPT,
  notifications = bell, connectors = blocks as in Claude…). The spec or review
  page names the product for each. Rail icons: 主页 House, 建议 Lightbulb,
  看板 Columns3, 插件 Blocks. Artifact is the one exception: it uses
  Mikka's own stacked-cards icon (R-56), never lucide Copy or Library.
  No sparkle for AI (unslop): thinking is Brain, a bot is Bot (ui-policy
  `icons/no-sparkle`).
- **R-76** Every workspace feature is on by default. Only a workspace admin
  turns one off (Settings › 工作区 or 团队权限), and members see the current
  value read-only. A stored off is an admin's choice, never a leftover
  default: a migration that turns a default on also rewrites rows that hold
  the old default. A feature stays off only for real per-use cost, an
  incident kill switch or a recorded Alex decision (`decisions.md`). Safety
  and money defaults (approval requirements, auto-recharge) are not features;
  they change only with Alex's decision. Source: Alex, 2026-10-31.
- **R-77** An app write has the permission its connection grants, and only
  a destructive call asks. If the Gmail, Calendar, Notion or Slack
  connection allows the write, the agent writes without a card. Explicit
  person or admin allow/ask/deny win first. Otherwise the Decisions API
  answers one predicate, `destructive`: does this exact call delete,
  overwrite or remove existing data? The tool's MCP annotations
  (`destructiveHint`, `readOnlyHint`) are input; a `readOnlyHint` tool is not
  asked about. Creating, sending, appending and adding never ask. An
  unavailable or refused judgment shows a card, never a silent write.
  Source: Alex, 2026-10-31.
- **R-78** Threads and runs are executed by an Agent (Claude Code, Codex…),
  so wherever a thread or run is drawn with an icon, the icon is that
  Agent's mark (`HarnessMark`, R-74); a thread whose Agent is unknown takes
  the neutral thread mark. A bot never does coding work: it appears only
  where it dispatched or owns the work (「<Bot> 派出线程」, the 概览 header),
  never as a thread's or run's icon, and neither does the Coordinator's
  avatar. Status icons stay where a list shows status (R-62, R-66).
  Source: Alex, 2026-11-01 (decision `2026-11-01-0110-agent-mark-on-threads`).
- **R-74** A named thing always carries its icon. Wherever the UI shows a
  device, a coding agent (harness), a model, a connected app or a provider
  account by name — rows, triggers, menu items, chips, thread headers,
  status lines — the icon comes first, then the name. Devices use their
  type (laptop, server = lucide Server, 云端托管 = cloud) plus the online dot;
  agents use their own brand mark (Claude Code, Codex, Cursor…); models use
  their provider's mark (Claude, OpenAI…); apps use the R-70 brand tile.
  Brand marks are the colored logo on its own, never set in a white disc or
  a bordered circle. There is no 自动 choice (decision 2026-10-30). Name-only
  text for these things fails review. Build them with the shared label
  components, not by hand.
- **R-72** Two kinds of work. A real task, such as coding, is a thread: a full
  coding agent (Claude Code, Codex) does it, and it is listed in the thread
  list. A web task is the bot's own: the bot runs it as a sub-agent (分身) with
  its own browser on the bot's cloud 电脑 (not the local 浏览器, R-57), and can
  run several at once. A sub-agent is never listed
  as a thread and has no name or avatar of its own; in the chat it shows as
  one card per web task with its live screen and a step line (进行中, 需要你操作,
  完成), and the bot itself reports what it did, in its own voice. The user
  never drives a sub-agent's screen. When a site needs a login, the card shows
  需要你操作, the bot says it in one message, and a 登录 <site> pill appears
  under it. Tapping the pill expands it in place into the login card (logo,
  登录 <site>, ✕; 邮箱, 密码; Google, Apple, 登录; 🔒 Secured by Mikka); ✕
  shrinks it back. No sheet and no sentence in the card. The login is saved
  to the user's encrypted vault (bound to the account, not one-time) and every
  thread and bot sub-agent of that user can use it; the model never sees it.
  Browsing is open to every site, with no allowlist. Once saved, the card collapses to 已登录 <site>.

- **R-73** Mikka is proactive as well as reactive (`proactive.md`). Besides
  rating incoming events (R-20), it keeps a per-person profile of facts drawn
  from mail, purchases, calendar and chats (interests, routines, places,
  subscriptions, deadlines, tools), shown and editable in 记忆, and once a day
  before the briefing it researches new cards from them: deadlines, tools'
  advisories, and interests matched with what is new nearby. New proactive
  cards are capped at 5 a day and written as R-21 cards with their source;
  interest cards are normal and stay in 建议; routine and location triggers
  go through the Coordinator under R-20's cap. Dismissals lower the fact's
  confidence. Profiles are per person, never shared in a workspace. Both the
  profile and the background research sit behind deployment flags (off by
  default when self-hosted), a per-person entitlement, the person's own
  toggles and a daily budget.
- **R-75** Workspaces are switched in one place: the account menu behind the
  avatar at the bottom of the rail (the bot list's footer on phones).
  Settings shows the current workspace's settings and has no switcher; its
  column starts with the 设置 title and search. The account menu is one flat
  `DropdownMenu`, no submenu, as Linear's and Notion's: each signed-in
  account's email (small, muted) with its workspaces under it (avatar, name,
  a check on the current one; about five show, more scroll), 创建工作区;
  then 设置 with its shortcut as one quiet text hint (⌘, not keycaps); then
  添加账户 and 退出登录. Every action row leads with a muted lucide icon in
  the same 20px box as the workspace avatars (创建工作区 `Plus`, 设置
  `Settings`, 添加账户 `UserPlus`, 退出登录 `LogOut`), so all rows share
  one text column. Menu text and item height are the defaults; the
  menu is 240px wide and opens above the rail avatar, never over it.

## Look

- **R-30** Greys are pure neutral: `rgba(0,0,0,a)` and `#737373 / #A3A3A3 /
  #171717` in light mode, the same idea in dark. Never slate, zinc or teal
  tinted. Main content is near-black (`text-foreground`); grey is for
  metadata, borders and hover only. One accent, `accent/default`
  (`--sidebar-primary`): no second brand hue on buttons or selections (the
  violet workspace and project accents now map to it; unslop, 2026-10-31).
- **R-31** No white hairlines. Inputs have a grey fill and no stroke. The
  sources to watch: shadcn `border-input` (dark `--input` is
  `oklch(1 0 0 / 15%)`), `ring-foreground/10` on dialogs and popovers,
  Comma's 0.5px hairlines, and column `border-l/r`. Inputs are decided;
  the app-wide sweep is open in `decisions.md`. Exception: a comment card
  and the comment box (R-63) carry a 1px `--border` line, which must be a
  dark grey in dark mode, never white at low opacity.
  Secondary buttons follow the same rule: a grey fill and no stroke, like
  the 「Add folder…」 button in Claude desktop's settings (a light grey pill
  on a white panel, no outline). `Button variant="outline"` and `variant="secondary"` (and the
  `outline` Toggle, the motion `secondary`/`outline` buttons) use the
  `--control` / `--control-hover` tokens, a translucent black (light) or
  white (dark) overlay, so the button still reads on grey cards and
  sidebars. Grouped buttons (`ButtonGroup`) keep a 2px gap so each one
  stays distinct, and `ButtonGroupText` is the same grey with no border.
  The top-bar search pill is grey too. Do not give a Button
  `bg-background`/`bg-card` with a border, or turn an outline Button back
  to white; ui-policy fails both as `style/secondary-button-fill`. Status
  tones (`statusTones`, used by status and priority pickers and status
  badges) are a tinted fill with no stroke; neutral uses `--control`.
  Search fields use `SearchInput` (`components/ui/search-input.tsx`): the
  `--control` fill, no stroke, the magnifier on the left and a light focus ring.
  ui-policy fails an outlined `Input`, `InputGroup` or `SidebarInput` used for
  search as `style/search-input`.
- **R-32** Type follows Comma (decision `2026-11-01-1204-type-follows-comma`):
  Inter Variable for text and Geist Mono for code, self-hosted from
  `app/fonts/` through `next/font/local` (no runtime font CDN, no metric
  fallback, `font-display: block`), then the system stack `"SF Pro Display",
  -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …, sans-serif`. No
  Chinese font is named: Chinese takes the system font (PingFang on a Mac), and
  no self-hosted text font may draw a CJK code point (`ui-policy.test.mjs`).
  Regular is 450 (`font-normal`); `font-synthesis: none`,
  `text-rendering: optimizeLegibility`, `-webkit-font-smoothing: antialiased`.
  A local font is only allowed after
  its file and CSS variable are registered in `ui-policy.json` →
  `typography.localFonts`. The size tokens are Comma's, set in
  `app/globals.css` and pinned in `ui-policy.json`: `text-xs` 12/18,
  `text-sm` 13/20, `text-md` 15/24, `text-lg` 18/28 and `text-xl` 20/30 at
  -0.01em, `text-2xl` 24/32. UI body is 13/20 (list titles in Medium), meta
  and group titles 12/18, badges 11/14 Medium, and 24/32 SemiBold for the
  建议 page title only (R-55). Documents people read (a task's title and
  description, the Artifact reader, comments) use 24/32 SemiBold title,
  18/28 SemiBold section heading, 15/24 Regular body and 12/18 meta; a
  smaller heading is the body size in SemiBold. Chat, the thread pane
  included, is 13/21 (`text-sm leading-5.25`, Comma's message text). Nothing is smaller than 11px. Labels are sentence case:
  no uppercase label with wide tracking (unslop; ui-policy
  `typography/uppercase-label`). Weights stop at SemiBold, never Bold.
- **R-33** Radii: 6 tag, 8 button and input, 9 rail item, 12 card and shell,
  14 approval and list card, 14 dialog (`rounded-xl`, the `DialogContent` /
  `AlertDialogContent` default; a call site does not change it), 999 pill. Spacing is a multiple of 4.
  Exception: 建议 cards use 16 (R-55). An `icon-sm` button (28px) extends
  its hit area to 40px on a coarse pointer with an invisible ring
  (interface-design, Alex 2026-10-31).
- **R-34** Status colours come only from the StatusBadge set (Figma
  `99:75`), shared by devices, threads and tasks.
- **R-35** Shell (Comma): grey window background, 44px top bar (back,
  forward, centred search pill that opens ⌘K, the 浏览器 globe toggle at the
  right, R-57), 68px icon rail, in this order: 主页, 建议, 看板, 插件,
  Artifact; and one rounded content card. Rail items are icons only: no text
  under the icon; the name shows as a tooltip on hover and stays the item's
  accessible name (Alex, #580; restored 2026-11-01 after #747 brought the
  labels back). Build on
  `components/app-shell.tsx`; no reUI App Shell blocks. Standing rule: a
  skill audit (unslop, interface-design) never changes the shell layout;
  Alex keeps it as it is (2026-10-31).
- **R-80** Every vertical line between two columns can be dragged to resize
  them (Alex: 「只要是这种竖线都可以 resizable」, decision 2026-11-01-1310):
  the bot list, the right panel, 建议's two halves, Artifact's list, the
  board's Coordinator sidebar, a task's right panel, the editor's side
  panel, a project's details, the settings list, the browser. The line is a
  `ResizablePane` or a `ResizeHandle` (`components/ui/resizable-pane.tsx`,
  on `hooks/use-resizable-width.ts`): drag it, use the arrow keys on it
  (Shift for bigger steps, Home and End for the limits), double-click it for
  the default width; it shows `col-resize` on hover, stays between a minimum
  and a maximum, and the width is remembered per place on this device. No
  second way to resize a column. `scripts/split-pane-policy.mjs` fails a
  fixed-width column with its own side border and no handle; a line that is
  not between columns says why with `split-pane-exempt: <reason>`.
- **R-36** Bots use bloub avatars (`BotAvatar`, Figma `196:3571`, all 16
  shapes kept); people use letter avatars. A person without an uploaded
  picture gets a generated gradient avatar (`public/avatars/*.webp`): after
  adopting the unslop skill Alex still requires it (2026-10-31), so it is
  intentional and not a violation. A bot's avatars move through the idle
  montage on one shared clock, so every animated copy of one bot shows the
  same pose. Small (`row`) and `still` avatars (group messages, members, the
  group avatar) hold the bot's own shape and do not play the montage.
- **R-37** Animate only when the user's action changes a size or position.
  Position and size move with springs; opacity and colour use a duration.
  Springs settle without visible overshoot (no bouncy springs). No hover
  scale or lift: hover is a colour or surface change, a press may scale to
  0.97. Transitions name their properties, never `transition-all` (ui-policy
  `motion/transition-all`); animate transform and opacity rather than
  width, height, top or left (unslop, interface-design).
- **R-38** Light-theme hover and column backgrounds use `rgba(0,0,0,a)`
  overlays, not a tinted overlay (an `rgba(16,24,40,…)` overlay read as mint
  green).

- **R-39** One container per surface. A bordered or rounded card never wraps
  another bordered card, outline item or loading card (a loading card inside a
  settings section is `SettingsLoading bare`); a dialog is the only surface for
  what it holds. A list row's hover and selected fill cover the whole row edge
  to edge; buttons and switches inside it stay separately clickable.
  `pnpm lint:ui` fails a frame inside a frame as `style/nested-frame`.

## Copy

- **R-40** No filler or explanatory copy in the UI (口水话; Alex repeated
  this on 2026-10-23 and 2026-10-24). How the remaining words must be written
  — status lines, no colloquial phrasing, no apology, no 「请」 — is
  [`copy.md`](copy.md) (C-01…C-08). If a sentence only explains the screen
  or narrates state, remove it. Examples that were removed: 「谁在工作 · 1 个
  agent 正在处理任务」 above the composer, 「和你的 Coordinator 聊聊」,
  「有值得看的会第一时间放到这里」, and on a login sheet the subtitle
  「Mikka 会把密码直接填进 Cloudflare 登录页，然后接着检查隧道。」 and the
  small print 「密码只填进 Cloudflare 的登录页，Mikka 不保存，也不会给 AI
  看」 (2026-10-27).
  - A sheet or dialog is a title, its fields and its button. No subtitle that
    says what will happen next.
  - Reassurance (privacy, security) is a short mark, never a sentence: a lock
    and 「Secured by Mikka」, as Stripe's 「Secured by Stripe」.
  - A status line names the state only (「已登录 Cloudflare」), not the next
    step (「…，继续检查」).
  - Test: delete the string. If the screen still says the same thing, keep it
    deleted. This applies to copy written in specs and agent briefs too: do not
    hand a designer or subagent an explanatory sentence to draw.
  - Data is not filler. An item in the 插件 store shows Composio's one-line
    description when Composio has one, as Codex's store does (decision
    2026-10-31); Mikka writes none of its own, so an item without one, and
    GitHub, Linear and Telegram, show icon and name only. Rows in 设置 › 连接
    have none.
- **R-41** An empty state is one colloquial line plus one button (often
  "send to a bot"). Never "这里是空的" or "Check back later".
- **R-42** Every visible string lives in `messages/zh-CN.json` and
  `messages/en.json`; `pnpm i18n:check` must pass. Write Chinese first.
- **R-43** Use the glossary's words: Bot, 对话, 线程, Agent, 资料库, 浏览器, 电脑.
  Never 会话 for a left row or a run, and never 任务 for the panel's thread
  tab. The right-side worker that does a thread's work (Claude Code, Codex) is
  an **Agent**, never harness or 执行器 in the UI; it runs on a 电脑 (your
  computer, an SSH server or Mikka Cloud). `scripts/check-copy.mjs` rejects harness and
  执行器 in `messages/`. 「Artifact」 is never translated. Built-in role names stay English
  (Coordinator).
- **R-44** The 建议 panel header greets by time of day and name
  (「早上好，Alex。」, `Shell.suggestions.morning` / `afternoon` / `evening`);
  it is a briefing, not a page headline. Every other title names the place or
  the period and never greets (unslop): the sign-in title is 「登录 Mikka」,
  not 「欢迎回来」. `check-copy` rejects greeting titles and exclamation
  marks.

- **R-45** A 建议 item, briefing item or follow-up item makes clear what to
  do and who or what it is about; never a bare report such as 「CI 挂了」 or
  「有人问…」. A 建议 list row is short and starts with a verb
  (「核对 Stripe 10 月账单」), as Comma ("Reply to Agenda") and ChatGPT do.
- **R-46** The Coordinator talks like a warm, professional, well-organised
  secretary, never like a command list. The briefing and follow-ups are
  natural sentences: it says what it sorted and why, names the person, offers
  to take the next step, and ends with one easy question
  (「早上好，Alex。今天有 4 件事：Kevin 来信…我可以按你的日历先起草一封回复。…
  先从 Kevin 那封开始吗？」).
  The daily briefing is one message (one bubble). Its tone follows Hark:
  for each item, what came in and why it matters to the person, then what
  the Coordinator can do about it (「我可以按你的日历先起草一封回复」).

## Tokens

The Figma variable collection `Mikka` (style guide section `98:2`) and
`app/globals.css` describe the same palette under different names. Use the
code token in code and the Figma variable in Figma. Values as of
2026-10-24 (light mode); a "drift" row is a known mismatch to fix in one
place, not a licence to pick either.

| Figma variable | Figma value | Code token | Code value | Drift |
| --- | --- | --- | --- | --- |
| `bg/canvas` (window) | `#f3f3f3` | `--shell-chrome` | `#f5f5f5` | yes |
| `bg/surface` (content card) | `#fdfdfd` | `--shell-panel` | `#f9f9f9` | yes |
| `bg/elevated` | `#ffffff` | `--shell-raised`, `--card`, `--popover` | `#ffffff` | |
| `text/primary` | `#171717` | `--foreground` | `#0a0a0a` | yes |
| `text/secondary` | `#737373` | `--muted-foreground` | `#606060` | yes (code darker on purpose, less grey) |
| `text/tertiary` | `#a3a3a3` | `--ink-3` | mix | check |
| `border/default` | `#00000014` | `--border` | `#e5e5e5` | close |
| `border/rule` | `#e5e5e5` / dark `#383838` | `--rule` | `oklch(0.922 0 0)` / dark `oklch(0.269 0 0)` | |
| `accent/default` | `#2f6bff` | `--sidebar-primary` | shadcn blue | yes |
| `status/*` | StatusBadge set | `--success`, `--warning`, `--destructive` | Tailwind palette | check |
| `brand/claude` (R-74 mark) | none yet | `--color-brand-claude` | `#D97757`, both themes | Figma to add |

The drift rows are open in `decisions.md`. Until they are settled, the code
value is what ships and Figma is updated to match.
