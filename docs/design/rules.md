# Design rules

These are decisions Alex has already made. Designs, specs and code follow
them without asking again. Scope: these rules govern Mikka's own UI. Paid blocks and components (BoardUI Pro, affectUI, beUI Pro) in the hosted layer are used as shipped, and where a rule here would change one's look (icons, avatars, logos, layout, spacing, colours, type, borders, motion, subtitles), the block wins ([2026-11-09-0050](decisions/2026-11-09-0050-paid-blocks-as-shipped.md)). To change a rule, Alex decides, the change is
recorded as a file in [`decisions/`](decisions/README.md), and this file is
edited in the same PR. A new rule's id (`R-xx`) is assigned by the
coordinator when the work is dispatched ([dev workflow](../dev-workflow.md)
§ 6). Cite rules by id in reviews ("breaks R-11").

Words (bot, chat, thread) are defined in [`glossary.md`](glossary.md). Which
source wins in a conflict is in [`README.md`](README.md).

## Bots, chats and threads

- **R-01** The left column is the bot list (bots and group chats). In the
  hosted shell each Bot can expand its dispatched tasks and Agent work beneath
  its own row, like Capy's Captains; tasks are named for the work and use their
  own state icon. Bots and groups retain their own avatars. This is not a
  separate global Agent list ([2026-11-10](decisions/2026-11-10-1317-capy-sidebar-and-task-layout.md)).
  Child work titles use the existing generated short title and are limited
  to 12 CJK characters or 6 words (60 characters maximum); the task code is
  separate from that budget. A missing short title has a bounded text fallback;
  the full task title stays in detail
  ([short titles](decisions/2026-11-10-1341-sidebar-short-title-limits.md)).
  The right column is 概览 with its tabs, including 任务, or 全部任务 (R-50).
- **R-02** The right panel's 概览 header shows the bot selected on the left:
  the same bloub avatar and the same name as its left row, then the tabs
  详情 / 任务 / PR / 电脑 (R-50). Task titles belong in their rows and
  details; this header names the bot. In the hosted edition 概览 is a tab of the chat's work area instead (decision `2026-11-09-2330-overview-as-work-area-tab.md`).
- **R-03** Choosing another bot on the left switches the centre chat, the
  right task list and the computer together.
- **R-04** Every bot comes with its own computer. There is no 新建云端电脑 entry
  anywhere, and no list of per-bot computers.
- **R-05** 「Bot 本身走我们自己的 AI SDK，跑在 Vercel 上。Bot 需要干活时，通过
  daemon 把任务派给 Claude Code 或 Codex。」 (Alex, 2026-11-01;
  [orchestration.md §3](orchestration.md)). Each allowed model names its Agent
  (「模型与订阅」, [1400](decisions/2026-11-02-1400-model-order-dispatch.md)); each Agent keeps its own 优先使用的模型, and dispatch tries the 优先使用的 Agent's list first ([0400](decisions/2026-11-05-0400-per-agent-model-lists.md)). The 新建 Bot dialog has a big live preview, a shape grid,
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
  button). Views that are not a conversation never get one: the task list
  and a bot's computer screen send instructions through the centre composer.
  An open thread is a conversation with the agent running it, so its detail
  ends in that composer and what is typed there goes to that agent, whether
  the thread is running or has ended (an ended one runs again, R-81), wherever
  it opens: task page, thread column, Artifact window, phone. Only the legacy
  agent archive is read-only
  ([decision](decisions/2026-11-02-0220-every-thread-ends-in-the-composer.md)).
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
  avatar and name, then its members (people and bots), recent tasks and
  files. No cloud computer in a group; open a bot's own chat to see its.
- **R-14** The user's messages sit in an accent-blue bubble with white text
  (`accent/default`); a bot's text sits in the light grey bubble. Charts,
  OpenUI cards and choice cards have no bubble. Bordered cards (document,
  computer, Artifact) sit below the text bubble, never inside it. A 建议 card
  the user taps is their message but keeps its card shape, no blue bubble; the
  instruction under it is a blue bubble (R-55). This holds in every one-to-one
  chat, the board's Coordinator sidebar and the AI sidebar included.
- **R-15** A task mentioned in chat is an inline chip: its state icon (R-52)
  and its code, such as 「◐ ALEX-45」, with the title, state and priority in
  the hover card; a task with no code shows its title. Internal object chips
  use the faint accent fill (`--object-chip`), rounded corners and accent
  text at the surrounding text's size and line height. A thread mentioned in
  chat is its title in the link colour, with no icon, fill, accent or state
  badge; the title never repeats the task's code. Every mention uses the same
  chip, with cards deduplicated under R-66. A dispatch's card represents its
  task and opens that task. Web sources keep the unboxed source chip.
  An Artifact waiting for acceptance is a bordered card under the reply
  (icon, name, state such as 待你确认), opening the Artifact window (R-56).
  Task-only cards and state icons supersede the former thread-bubble/dot
  presentation ([2045](decisions/2026-11-07-2045-tasks-only-threads-inside.md),
  [2230](decisions/2026-11-07-2230-one-icon-per-task-state.md),
  [0659](decisions/2026-11-10-0659-task-code-chips-and-work-area-tabs.md)).
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
- **R-21** 建议 is its own rail page (R-55), not part of the right panel (R-50). 建议 is the normal-level
  items in one list, newest first, each row with its app's icon (no per-app
  cards). The daily briefing is not in 建议; it is the Coordinator's 08:00 message, also
  sent right after the person connects an app. A thread started by the
  orchestrator or a bot belongs inside its task, which is listed under R-52. 建议 items are standalone cards, each one
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
  建议 when done; the dispatched task also shows up in the task lists.
- **R-22** Tasks are never created on the board itself: no column `+`, no
  status pick. The 新建任务 button, ⌘K and `c` open one dialog where the user
  describes the task in a sentence and the Coordinator writes it, or types
  the title themself in an optional title field above the description
  ([decision](decisions/2026-11-10-1213-new-task-optional-title.md)). The
  dialog shows a machine picker.
- **R-23** Machine picker order: **Mikka Cloud** first; then the group
  **本机** (this Mac, a local Linux machine); then the group **Remote
  control** (VPS and SSH hosts reached through the user's machine). Settings ›
  设备 uses the same two groups. The default is the first machine that can
  run the task now: Mikka Cloud only with the person's own E2B key, a device
  only while online. Without a key Mikka Cloud is grey and marked 填入 E2B Key,
  which opens the key dialog. A dot is green only while the machine is
  actually online (Mikka Cloud: running)
  ([decision](decisions/2026-11-01-2250-default-first-usable-machine.md)).
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
- **R-26** Team workspace tasks sync with Linear (`MIK-xx`); tasks in the
  personal workspace stay in Mikka. Personal and team workspaces are kept
  apart: a task or chat never moves between them
  ([decision 2026-11-01-2310](decisions/2026-11-01-2310-personal-and-team-workspaces-apart.md), which replaces turning a
  workspace task back into a personal one, issue #184). Content visibility uses
  the resource ACL and restrictive Project/Thread parents, in addition to active
  Workspace membership. Shared collaboration does not expose private Bot chats
  or memory; historical private data remains private
  ([#1849 decision](decisions/2026-11-10-0017-collaboration-governance.md)).

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
  The task page's breadcrumb starts at the place it was opened from (R-82).
  A group heading that names the
  workspace its settings apply to (设置's workspace group) is not a crumb and
  stays.
- **R-62** A task's 活动 lists its creation, its events and one row per Agent
  stretch, oldest first: consecutive runs by the same Agent are one row, and
  every row is labelled with its Agent's mark and name, never a 「换」 verb, as
  Warp labels runs ([2026-11-09-0045](decisions/2026-11-09-0045-no-attempt-word.md)).
  There is no per-run thread list. A row shows its stretch's latest run in the
  run-result words (glossary: Run result) and
  opens the task's single conversation at the stretch's first run (R-81),
  ending in the shared composer (R-10). The task properties
  show its dispatching bot, Agent/model and execution location. A reader who
  cannot access the work sees no private transcript. Workspace visibility
  follows [#1849](decisions/2026-11-10-0017-collaboration-governance.md)
  and the enforced resource ACL. Authorized teammates can watch the
  conversation and contribute according to their capabilities; triggering
  execution or owner-funded resources requires separate authorization and budget.
  The bot dispatches the work and the Agent runs it (R-78). A person's private
  Bot chat stays private until its owner explicitly shares it. A shared link is
  not permission to use the owner's private credential, device, Secret or memory.
  Administrators without a content grant see only the separate management and
  usage projection, never a private transcript or title.
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
- **R-66** A dispatch in chat shows one task card under the first reply that
  dispatched or mentioned it. The card carries its state's icon, number,
  title and one grey line with state, dispatching bot and time. It updates in
  place; later mentions use inline references and repeated event lines retain
  the latest state. It opens the task detail, from which the person opens the
  task's conversation (R-82), on desktop beside the chat and on the phone as
  a pushed page. It has no log, composer or progress checklist. This follows
  [2045](decisions/2026-11-07-2045-tasks-only-threads-inside.md) and replaces
  the former directly opening thread card. Deliverables stay in the Artifact
  window (R-85).
- **R-81** A task has one thread at a time (Alex, 2026-11-01). Dispatching a
  task that already has a thread gives that thread the work: while it works
  the note goes in as a message; once it ended (done, failed, stopped) it runs
  again in the same thread, resuming the agent's session where it can. The
  thread's root identity does not change across its continuation runs. Only the person's explicit request for a new
  session or thread, or another agent, starts a new one; the old thread is
  stopped and marked replaced. The task still has one conversation joining
  every run oldest first; a 活动 row opens it at that Agent stretch, and
  replies go to the newest run
  ([2300](decisions/2026-11-07-2300-one-conversation-per-task.md)).
  The server enforces this at every dispatch
  entry, not the prompt ([decision](decisions/2026-11-01-1330-one-thread-per-task.md)).
  The person may name where it runs (one of their computers, or the cloud);
  a named computer that is offline gets the 没有可用的电脑 card, never another
  computer, and the reply names only where the run actually is.

## Right panel, 建议, Artifact and browser

Figma: page `395:15023`, frames F1–F10 (listed in `decisions.md`).

- **R-50** The right panel is the right third of the window. 概览 names the
  selected bot (R-02), followed by 详情 / 任务 / PR / 电脑. 任务 lists the
  tasks that bot dispatched. 电脑 shows its cloud computer (`AgentComputer`).
  The window bar's 全部任务 entry opens all dispatched tasks in the right
  column while keeping the centre chat. Search, widen and close act on that
  column. A thread opens from its task's 活动 into the task's one conversation
  ([2045](decisions/2026-11-07-2045-tasks-only-threads-inside.md),
  [2300](decisions/2026-11-07-2300-one-conversation-per-task.md)).
- **R-51** The right panel is read-only. No action buttons anywhere in it (no
  让它安排, 新建, 上传 or arrange). Besides navigation (the pills, the tabs, the
  header's search, widen and close, and a list group's collapse chevron), the only
  controls are 「展开」 to expand a list and, in a bot's 概览 header, its own name
  and avatar: clicking the name renames it in place (Enter or leaving saves, Esc
  cancels) and clicking the avatar opens the 新建 Bot shape and colour picker
  (2026-10-31). The Coordinator's header stays read-only. An ordinary bot's 详情
  also lets its owner edit 公开职责 (public role, #1158), with Save and Cancel.
  This public description guides group routing; it never grants tools or exposes
  private instructions. The field accepts at most 2,000 characters; saving an
  empty value clears it. 详情 also holds 例行 (routines) and 资料库 (library).
  The bot creates routines when asked in chat; files are
  uploaded with the composer's 「+」. 资料库 can delete the person's own files:
  each row has 删除, shown on hover or focus, and confirms first (Alex,
  2026-11-01: 「自己上传的文件，在资料库里可以删除」;
  [decision](decisions/2026-11-01-2255-library-delete-own-files.md)).
  Exception: a coding task's review page ([2026-11-08-1230](decisions/2026-11-08-1230-coding-workspace.md)) carries
  actions (line comments, 发给 Agent, 附到评论, 批准合并). On a coding
  task, the task panel's ⋯ menu also lists the code tools 改动 · 文件 · 终端 ·
  预览, and its PR summary line opens the review page; these only open the
  review page, and the rest of the panel stays read-only.
- **R-52** Every list holds tasks, grouped **等待你 · 进行中 · 待办 · 已完成**.
  已完成 starts collapsed. Each row carries its own state's icon, independent
  of the group header's icon
  ([states](decisions/2026-11-07-2230-one-icon-per-task-state.md),
  [attempts](decisions/2026-11-07-2300-one-conversation-per-task.md)).
  - 等你处理 uses a hand, for a question, approval or PR review. 受阻 uses an
    octagon for login, key, permission, quota or an offline device. 失败 uses
    a triangle. These states appear in 等待你. The window-bar hand counts
    only 等你处理 tasks.
  - 运行中 uses a ring and 排队中 a clock, under 进行中. Open tasks without an
    active attempt appear in 待办 with their board icon. Closed tasks use
    their board icon under 已完成.
  - A dependency or manual blocked flag supplies its reason in the grey line
    and keeps the task's own state and icon. It does not acquire the hand.
  - `agent_runs.outcome` supplies the ended attempt's judgement, based on
    its reply, status, task and PRs (`lib/run-outcome-judge.ts`). A finished
    process alone does not prove success. A missing judgement cannot mark
    an unresolved task complete.
  - Task icons use semantic colours. 等你处理 is blue, 受阻 / 运行中 /
    排队中 / 进行中 orange, 评审中 blue, 失败 red, 完成 green, and
    待办 / 暂不处理 / 已取消 / 重复 grey. The reason line stays secondary text. There are no status
    dots, corner marks or badges
    ([colours](decisions/2026-11-08-0130-task-state-icon-colours.md)).
  - An attempt shows its own result icon, never the hand. Running uses the
    ring, waiting for the person uses pause, finished a check, failed a
    triangle, blocked an octagon, and replaced no icon.
- **R-53** A task row shows its state icon, number, title and date, with a
  grey line for the reason, dispatching bot and schedule when present. Raw
  error codes stay under 详情 inside the relevant attempt. The former
  thread-list last-reply preview is superseded by
  [2045](decisions/2026-11-07-2045-tasks-only-threads-inside.md).
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
  Factory acceptance uses the same window: its left side is the acceptance
  report Artifact (HTML or Markdown, evidence inline), its right side the
  thread that did the work, and the task page has a 验收 button that opens it
  (decision `2026-11-04-2200-factory-flow-like-warp.md`; it replaces the 「验收」
  tab of 2026-10-30).
- **R-57** The local 浏览器 is an icon-only globe toggle at the right of the
  top bar, with no 「浏览器」 label. Turned on, it opens a right column with
  the browser (URL bar and page). In the hosted edition 浏览器 is a work-area tab opened from the New tab's Tools or ⌘⇧B, with no globe in a window bar (decision `2026-11-09-2330-overview-as-work-area-tab.md`). Selecting an element and annotating it puts
  a chip 「1 · <element> · <action> · <note>」 into the current chat's
  composer. The 浏览器 is the person's own and app-wide; it is not a bot's
  电脑 (R-50).

## Navigation

- **R-82** One address describes what is on screen. All moves use
  `components/workspace/workspace-navigation.ts`; `scripts/navigation-policy.mjs`
  checks direct history writes and workspace links. A user move pushes
  history and a filter or tab replaces it. Back and forward restore each move.
  - Bot and group chats open in the centre. 看板 contains tasks, projects and
    teams. A task opened from 看板 or a link is a centre page. Its origin
    crumb and close action return to the source, defaulting to 看板; ↑↓
    appear when it was opened from a list.
  - A chat task card, task chip or right-panel task row opens the task view
    as a tab in the chat's right work area, preserving the chat; its expand
    button opens the same task as a page. A thread, Agent stretch or subagent
    opened from a chat opens its own work-area tab, reused when already open
    ([0659](decisions/2026-11-10-0659-task-code-chips-and-work-area-tabs.md)). A row in 活动 (one per Agent
    stretch, R-62) opens that task's one conversation, with ← back to the
    task. The conversation joins runs oldest first, opens a selected stretch
    at its first run and otherwise starts at the newest message. Its header
    is the task title and current Agent; its composer addresses the newest run.
    The hosted work-area task view starts with one large editable title,
    its code and time, then compact properties, description, subtasks and
    activity. The tab names the task; no second inner title bar repeats it.
    Save, more and expand stay available
    ([Capy layout](decisions/2026-11-10-1317-capy-sidebar-and-task-layout.md)).
  - 全部任务 opens from the window bar on every page, with the hand and the
    count of 等你处理 tasks. A bot's 任务 tab lists its dispatched tasks.
    Search hits in a task conversation resolve to the task. Legacy run IDs
    and `?threads=` remain routing identifiers, not list labels.
  - On the phone task detail and its conversation push over the task tab.
    Bot · 任务 · 建议 · 设置 and search are the native tabs; the tab bar hides
    on pushed chats and task pages. Workspaces switch in 设置 › 工作区.
  - A coding task's summary line or 审阅 opens the dedicated review page,
    with the task conversation beside its final diff. Code tools live in ⋯
    under [1230](decisions/2026-11-08-1230-coding-workspace.md); there is no
    attempt-based diff scope. Its selected UI layer and backend contract
    determine implementation coverage.
  - An Artifact opens in its shared window over the page (R-56). PRs and web
    pages open in a new tab. Phone web uses a full-page right column and
    retains a bot-list/header entry. Invalid addresses normalize to the
    authorized visible location.
  Sources are [navigation](decisions/2026-11-01-1320-navigation-model.md),
  [task lists](decisions/2026-11-07-2045-tasks-only-threads-inside.md) and
  [one conversation](decisions/2026-11-07-2300-one-conversation-per-task.md).
  The UI is the official build ([one UI](decisions/2026-11-08-2133-one-ui.md));
  default slots in this repository can retain older thread presentation
  ([UI slots](../ui-overlay.md)).
- **R-83** A reply's tool calls say what they did, not that a tool was used
  ([decision](decisions/2026-11-04-2221-chat-tool-groups-and-citations.md),
  spec `chat-tool-calls.md`). Two or more calls with nothing said between them
  are one line that sums up what succeeded, side effects first, and counts the
  failures apart in red (「派发了 1 个线程，查看了 3 次任务 · 1 个失败」); a failed
  call is never said as done, and a group where nothing succeeded names the calls
  that failed. Closed by default; while the
  reply streams it shows the call running now. Opened, each call is a row: its
  kind's icon, then verb and object (「查看任务 ALEX-45」); never a bare
  「使用工具」 (`check-copy`). A call that failed, thrown or answered
  `{"error": …}`, is red and names its reason in words. An opened call says
  what it did in words first, ids never shown: a dispatch is 「交给」 and the
  coding agent with its mark (R-74), never the bot, then its task reference, then
  its note as a quote (three lines; only a cut note opens to the rest); a thread
  the chat has not loaded is its state in words (「交给 Codex · 进行中」), the
  state the dispatch answered with, not the thread's state now. In a dispatch
  one task reference identifies the dispatched work and leads through its
  task (R-15, R-66). A call whose
  object is a task (create, update or look up tasks) draws that task's chip. Other
  known tools name their object, query, count or status; an unknown tool lists
  at most six of its own fields, cut short. A failed call says nothing more in
  words: its row names the reason. Raw input and output sit last, under
  「原始数据」, folded. 全部展开 / 全部收起, always shown beside every
  group, opens or closes every group in the chat. Under a reply, 复制 and 「N 个来源」 (web pages
  only; tasks and threads are already chips) share one line that shows while the
  reply is hovered, focused or tapped; the latest reply keeps it on a touch screen.

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
  value read-only. A person's own subscriptions and API keys are not such a
  feature. A person's subscriptions remain Account-owned and are not a public
  resource pool. Organization connection and model policies govern admitted work
  without revealing personal credentials; authorized owner use stays available
  under [#1849](decisions/2026-11-10-0017-collaboration-governance.md).
  A stored off is an admin's choice, never a leftover
  default: a migration that turns a default on also rewrites rows that hold
  the old default. A feature stays off only for real per-use cost, an
  incident kill switch or a recorded Alex decision (`decisions.md`). Safety
  and money defaults (approval requirements, auto-recharge) are not features;
  they change only with Alex's decision. Source: Alex, 2026-10-31.
- **R-77** An app write has the permission its connection grants, and only
  a destructive call asks. If the Gmail, Calendar, Notion or Slack
  connection allows the write and the call is not destructive, the agent
  writes without a card. The workspace's allow/ask/deny wins first for
  `call_app_tool`; there is no per-Bot or per-person layer. Otherwise the
  Decisions API answers one predicate, `destructive`: does this exact call
  delete, overwrite or remove existing data? The tool's MCP annotations
  (`destructiveHint`, `readOnlyHint`) are evidence; none of them skips the
  call. Creating, sending, appending and adding never ask. An unavailable,
  refused or malformed judgment shows no card: the call goes ahead and the log
  records `Write judgment fallback`. The hand-written Gmail, Calendar, Notion,
  Slack and Drive tools are unchanged; the Coordinator's Gmail/Calendar writes
  use the same judge in `writeAccountAction`. Source: Alex, 2026-10-31.
- **R-78** Threads and runs are executed by an Agent (Claude Code, Codex…)
  in an Agent 配置. Where an Agent stretch is drawn with a mark (the line where
  the Agent changes, a plan step, the execution identity), the main mark is
  its Agent 配置's mark and the Agent's own mark (`HarnessMark`, R-74) sits
  beside it, smaller, or in the details; a stretch with no Agent 配置 takes
  the Agent's mark, and one whose Agent is unknown the neutral thread mark.
  A thread mentioned in text has no mark (R-15). A bot never does coding
  work: it appears only where it dispatched or owns the work (「<Bot> 派出线程」,
  the 概览 header), never as a thread's or run's icon, and neither does the
  Coordinator's avatar. Status icons stay where a list shows status (R-62,
  R-66). Source: Alex, 2026-11-01 (decision
  `2026-11-01-0110-agent-mark-on-threads`), revised 2026-11-10
  ([0659](decisions/2026-11-10-0659-task-code-chips-and-work-area-tabs.md)).
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
  coding agent (Claude Code, Codex) does it, and the dispatched task appears in
  the task list. A web task is the bot's own: the bot runs it as a sub-agent (分身) with
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

The Look rules (R-30 to R-39) and the avatar, icon and chip rules elsewhere
are Mikka's look. They are never applied inside a paid block, which keeps the
library's shipped look ([2026-11-09-0050](decisions/2026-11-09-0050-paid-blocks-as-shipped.md)).

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
  `app/fonts/`, registered by the shared renderer's `@font-face` rules in
  `apps/desktop/src/renderer/styles.css` (no runtime font CDN, no metric
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
  Exception: 建议 cards use 16 (R-55). On a coarse pointer every `Button`,
  `Toggle`, `ToggleGroupItem` and `SelectTrigger` extends its hit area to at least 44×44px with
  an invisible `::after` (`lib/touch-target.ts`), and drawer rows on a phone
  are 44px tall; the desktop look does not change (interface-design, Alex
  2026-10-31; WCAG 2.5.5, HCI review M7).
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
- **R-37** Panels and columns open, close and switch instantly: the right
  column, an open thread taking its place, the bot list, the Artifact window
  and the sheets that stand in for them get no slide, fade, zoom, width or
  height animation ([decision](decisions/2026-11-01-2320-panels-open-instantly.md)).
  Otherwise animate only when the user's action changes a size or position.
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
- **R-91** Top rows carry the important things. The first row of a panel,
  page or screen holds the object's state (for a coding task: PR and failed checks right
  under the title). Tools and secondary actions go into the header's 「⋯」
  menu, tools first (for a coding task: 改动 +N −M, 文件, 终端, 预览, with
  their shortcuts), then a divider and items such as the branch name, copy
  link and permissions; shortcut hints go into tooltips. They are not visible
  buttons on the header row (Alex: 「只要求你把这些东西放进省略号里边…不是放在
  省略号的外边」). Secondary
  actions, branch names, counts and shortcut hints go into 「⋯」 or a
  tooltip, not a row of their own (Alex, 2026-11-08; [2026-11-08-1230](decisions/2026-11-08-1230-coding-workspace.md)).

## Design review

Hard checks for every design handed in (Figma or code), added after Alex's
review of the Factory redesign on 2026-11-04
(`decisions/2026-11-04-2230-design-review-checks.md`). R-83 is reserved for
the chat tool group (`chat-tool-calls.md`). Each check is pass or fail; a
design that fails any of them is sent back before it reaches Alex.

- **R-84** A thread's conversation always uses the existing thread view
  (`IssueThreadPanel`, drawn as its code renders it: the person's prompt
  first, collapsible `ThreadSteps`, the agent's grey bubbles and its composer;
  in `bare` mode, as inside the Artifact window, no header and no tabs),
  wherever it appears: the Artifact window, the session view,
  an inbox detail. A one-to-one bot chat uses the existing coordinator chat.
  No design draws a third chat style or adds a new chat component.
- **R-85** Deliverables (PR, diff, recording, screenshot, test output) live
  on the acceptance page (the Artifact window, R-56). Coding-task diffs, PR
  checks and review actions also live on the dedicated review page under
  [1230](decisions/2026-11-08-1230-coding-workspace.md). The task's
  activity timeline and the bot's comments carry one plain sentence about
  progress and at most an 「打开任务」 link, never deliverable chips.
- **R-86** A bot asks the person its questions in its own chat with them. The
  task page shows only that a question is waiting (stage 「在问你」 and a
  「去回答」 button that jumps to the message); after the answer, the activity
  records one line 「你回答了：…」. No question-and-answer box on the task page.
- **R-87** Every status, verdict and severity is shown with an icon, a colour
  and a word together, at body size, on a tinted background where it needs
  attention (for example 高 red with `CircleAlert`, 中 amber with
  `TriangleAlert`, 低 grey with `Info`). Never colour alone, never pale small
  text. Task and attempt rows follow R-52's coloured glyph plus state text
  presentation, without status badges or dots.
- **R-88** At 1440 wide, no screen leaves an empty area larger than about a
  third of the viewport. A list with a detail pane keeps the list narrow
  (about 320px) and fills the detail with the thing to act on (for example
  the acceptance page itself), not a summary and a button.
- **R-89** The primary entry for what the person must do next is visible on
  first sight without scrolling: one prominent block or button per screen
  (for example the task page's 验收 block under the description), not a small
  header button or a link inside a comment.
- **R-90** Reuse before you draw or build. Before a screen or a part of one is
  designed (Figma) or coded, look up the component for that job, in this
  order: `components.md`; the product's own components already on the live
  screen for the same job (thread view, coordinator chat, Artifact window,
  board card, chips); then the libraries `components/reui/`,
  `components/ui/` (shadcn, including ones nothing imports yet, such as
  `Questionnaire`), `components/motion/` and the OpenUI catalog
  (`lib/agent-ui-catalog.ts`). If one fits, the design draws it as its code
  renders it and the code uses it; restyling or redrawing a near copy fails
  this check. A new component is allowed only when none fits, and the same
  PR adds it to `components.md` with the reason. The design hand-in lists,
  for every part, the component it uses or why a new one was needed.

How a design is reviewed:

1. The author's self-score is a reference only. An independent reviewer that
   did not author the design (a fresh agent given only the screenshots, the
   live product for comparison and these checks) scores it with
   `ux-heuristics` and runs `cognitive-walkthrough` on the key tasks.
2. The reviewer looks at full-size screenshots and compares them side by side
   with the live product's current screens, not thumbnails.
3. The reviewer goes through R-84 to R-90 one by one and reports each as pass
   or fail with the screen it checked.

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
  - A settings switch or choice may carry one short line saying what it does
    and what happens when it is on or picked (Alex, 2026-11-05, on 模型与订阅:
    he could not follow 「这个工作区 / 分享给团队成员」 or 「依次用：云端 →
    服务器 → 电脑」; [0400](decisions/2026-11-05-0400-per-agent-model-lists.md)).
    In plain words, as short as it can be, and each line still passes the delete
    test: if removing it loses nothing a newcomer needs, it goes.
- **R-41** An empty state is one concrete state line plus one button (often
  "send to a bot"). Never "这里是空的" or "Check back later".
- **R-42** Every visible string lives in `messages/zh-CN.json` and
  `messages/en.json`; `pnpm i18n:check` must pass. Write Chinese first.
- **R-43** Use the glossary's words: Bot, 对话, 线程, Agent, 资料库, 浏览器, 电脑.
  Never 会话 for a left row or a run. The panel's list tab is 任务;
  threads are reached through their task. The right-side worker that does a thread's work (Claude Code, Codex) is
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
| `text/tertiary` | `#a3a3a3` | `--ink-3` | `--muted-foreground` 90% into `--background` (oklch). Text only in the source list's domain (`streaming-text.tsx`), on `bg-inset`, hovered `--hover`: light 4.62 / 4.74, dark 4.82 / 5.09 | deliberate (Figma lighter; code holds 4.5:1, [decision](decisions/2026-11-05-0040-ink-3-holds-contrast.md)) |
| `border/default` | `#00000014` | `--border` | `#e5e5e5` | close |
| `border/rule` | `#e5e5e5` / dark `#383838` | `--rule` | `oklch(0.922 0 0)` / dark `oklch(0.269 0 0)` | |
| `accent/default` | `#2f6bff` | `--sidebar-primary` | shadcn blue | yes |
| `status/*` | StatusBadge set | `--success`, `--warning`, `--destructive` | Tailwind palette (500; red 600 light) | check |
| `status/*` text | — | `--success-foreground`, `--warning-foreground`, `--destructive-foreground`, `--info-foreground` | light: emerald / yellow / violet 900, red 800; dark: emerald / yellow / violet 400, red 300 | |
| `status/warning` mark | — | `--warning-ink` | light yellow 900, dark `--card`: the 紧急 square's ! on solid amber (R-87) | |
| `brand/claude` (R-74 mark) | none yet | `--color-brand-claude` | `#D97757`, both themes | Figma to add |

A status word or icon, on a status tint (a badge) or on its own, takes the
`*-foreground` token, never the status colour itself: the colour is the tint and
the dot, the foreground is what is read (4.5:1 or more in both themes; amber
500 on white is 1.9:1). Measured 2026-11-04 on the badge tint (status/15 in
dark, status/10 in light):

| Text on tint | Light | Dark on page | Dark on card |
| --- | --- | --- | --- |
| warning | 8.13 (was the 500 base: 1.79) | 8.44 (was 600: 4.52) | 7.36 (was 600: 3.94) |
| success | 8.81 (was 500: 2.24) | 7.27 (was 600: 3.84) | 6.38 (was 600: 3.36) |
| destructive | 7.01 | 7.52 with red 300 (was 600: 3.03) | 6.61 (was 600: 2.66; red 400 would be 4.39) |
| info | 9.70 | 5.37 with violet 400 (was 600: 2.60) | 4.74 (was 600: 2.30) |

The drift rows are open in `decisions.md`. Until they are settled, the code
value is what ships and Figma is updated to match.
