# Design rules

These are decisions Alex has already made. Designs, specs and code follow
them without asking again. To change a rule, Alex decides, the change is
logged in [`decisions.md`](decisions.md), and this file is edited in the same
PR. Cite rules by id in reviews ("breaks R-11").

Words (bot, chat, thread) are defined in [`glossary.md`](glossary.md). Which
source wins in a conflict is in [`README.md`](README.md).

## Bots, chats and threads

- **R-01** The left column is the bot list (bots and group chats). The right
  column is the thread list. There is no "conversation list".
- **R-02** The right panel's 详情 header shows the bot selected on the left:
  the same bloub avatar and the same name as its left row, then 「<Bot 名>
  的屏幕」. A thread's name appears only as a row in the thread list, never as
  that header.
- **R-03** Choosing another bot on the left switches the centre chat, the
  right threads and the computer together.
- **R-04** Every bot comes with its own computer. There is no 新建云端电脑 entry
  anywhere, and no list of per-bot computers.
- **R-05** Bots run only on Mikka's own AI SDK harness. The 新建 Bot dialog
  has a big live preview, a shape grid, colours and a name. It has no machine
  picker, no harness picker and no 说明 field (instructions are edited in chat).
- **R-06** The Coordinator has no special UI; it is a normal bot (Alex
  2026-10-24). Its role is coordinating, not looking different: the same
  bloub avatar with no star or badge, the same row, the same chat, the
  same empty state as any other bot. Never the letter C.
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
- **R-11** The composer has no model picker. The model is our default;
  BYOK users will choose it in Settings later.
- **R-12** No starter or suggestion cards in any chat ("试试从这些事情开始").
  Suggestions live only in the 建议 list. A new bot greets with one bubble
  and an A–D choice card.
- **R-13** One-to-one chats (a bot, the Coordinator, the board's Coordinator
  sidebar) show no avatar or name on messages; the header pill names the bot.
  Group chats show a 24px avatar on the left of the bubbles at the bottom of
  each run and the name once per run, 12px Medium in the bot's colour (Figma
  `224:5023`). A group's 详情 is about people, not computers: the group
  avatar and name, then its members (people and bots), recent threads and
  files. No cloud computer in a group; open a bot's own chat to see its.
- **R-14** The user's messages sit in an accent-blue bubble with white text
  (`accent/default`); a bot's text sits in the light grey bubble. Charts, OpenUI cards
  and choice cards have no bubble. Bordered cards (document, computer) sit
  below the text bubble, never inside it. This holds in every one-to-one
  chat, the board's Coordinator sidebar and the AI sidebar included.
- **R-15** A task or thread mentioned in chat is an inline chip, not a large
  card (a task chip carries the board's status icon). A thread the reply
  dispatches is different: it is a thread card under that reply (R-66).
- **R-16** The computer card in chat shows a title, a status, one sentence
  about the task and a big screen. Approval is part of that card. It never
  shows an operation log, a step checklist, or OS and spec lines.
- **R-17** The caption under a bot's screen is 「<Bot 名> 的屏幕」 and nothing
  else.

## Suggestions, tasks and devices

- **R-20** Notifications from connected apps' webhooks (Gmail, Notion,
  Slack, GitHub, Linear…) are rated by the decision model (OpenAI Decisions
  API) after Comma's attention model: first the cost if the person does
  nothing, when it lands and whether it can be undone; then one level,
  critical, high, ask, normal or low (unclear rereads the source). Code floors
  the level: any cost is at least high; a cost due within 48 hours, or an
  irreversible one due within a week, is critical. Only the Coordinator speaks to the person about events: no
  push, chat message or Telegram/Slack message is sent around it. Critical,
  high and ask go to the Coordinator at once; the 08:00 briefing is handed to
  it too. It tells the person only when they must act before the next
  08:00 briefing, or when a cost that cannot be undone lands within a week;
  everything else waits in 建议 for the briefing. When unsure, it stays
  quiet. It also stays quiet when fresh evidence shows the matter resolved,
  owned by someone else, or already covered in the chat. When the daily cap
  is spent, a matter the person must still act on is snoozed until the cap
  reopens, never dropped. Telling the person is a card in its
  own chat that says what happens if nothing is done and offers one next
  step, pushed on mobile. Normal stays in 建议; low is not shown. Telling the
  person is capped at 5 a day, 30 minutes apart (critical skips the spacing,
  not the cap); held items wait, they are not dropped. The Coordinator never
  acts on an event before the person says yes. Its own ideas also go in its
  chat.
- **R-21** The right panel has two parts: 建议 on top, then 任务. 建议 keeps
  its name (not "Routines"): a daily briefing generated at 08:00 in the
  person's time zone, and again right after they connect an app, then the normal-level items in one list, newest first, each row with
  its app's icon (no per-app cards). A 任务 here
  is a thread started by the orchestrator or a bot; all of them stay listed.
  It is not a flat list of the board's issues. The flow: the person says yes
  to a Coordinator card, or clicks a 建议 item (which fills the centre
  composer) → the bot dispatches a thread → the item leaves 建议 and shows up
  below as a 任务.
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
- **R-25** Board cards show the id, the assignee's avatar (never a name),
  the status icon, the title, then one row with priority, labels, linked PRs
  and the latest run's state. Only the run state is a tinted pill; priority,
  labels and PRs are bare icon + text with no border, wrapping onto a second
  row when needed. The board is the reUI Kanban with no column `+` (R-22) and
  no page-title pill (the rail says where you are). With the Coordinator
  sidebar open, 已完成 collapses to a 40px strip (icon, vertical name, count)
  so the other columns are never cut off. Figma: section `77:2`.
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
- **R-62** 线程 lists the threads working on the issue: status icon (never
  the bot's avatar, `glossary.md`), thread name, one line on what it is doing, status, time. Clicking one opens it on
  the right as a conversation that ends in the composer (R-10); people and
  the agent talk there. A thread's content is its owner's alone: teammates
  (R-26) see 「<人> 的线程」, its status and time, and cannot open or join it,
  as GitHub Copilot and Cursor keep agent sessions private; what the thread
  produces (a PR, a comment its owner posts) is how the team sees the work. The bot runs the thread (R-05); a coding agent it hands work
  to (Codex, Claude Code) shows as a step 「交给 Codex · …」, never as the
  runner in the list or the header.
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
  page names the product for each.

## Look

- **R-30** Greys are pure neutral: `rgba(0,0,0,a)` and `#737373 / #A3A3A3 /
  #171717` in light mode, the same idea in dark. Never slate, zinc or teal
  tinted. Main content is near-black (`text-foreground`); grey is for
  metadata, borders and hover only.
- **R-31** No white hairlines. Inputs have a grey fill and no stroke. The
  sources to watch: shadcn `border-input` (dark `--input` is
  `oklch(1 0 0 / 15%)`), `ring-foreground/10` on dialogs and popovers,
  Comma's 0.5px hairlines, and column `border-l/r`. Inputs are decided;
  the app-wide sweep is open in `decisions.md`. Exception: a comment card
  and the comment box (R-63) carry a 1px `--border` line, which must be a
  dark grey in dark mode, never white at low opacity.
- **R-32** Font Geist, Chinese falls back to the system font. Only these text
  styles: 20/28 SemiBold, 15/22 SemiBold, 14/22 Regular (chat), 13/20 Regular
  (body), 13/20 Medium (list title), 12/16 Regular (meta), 12/16 Medium
  (group title), 11/14 Medium (badge).
- **R-33** Radii: 6 tag, 8 button and input, 9 rail item, 12 card and shell,
  14 approval and list card, 16 dialog, 999 pill. Spacing is a multiple of 4.
- **R-34** Status colours come only from the StatusBadge set (Figma
  `99:75`), shared by devices, threads and tasks.
- **R-35** Shell (Comma): grey window background, 44px top bar (back,
  forward, centred search pill that opens ⌘K), 72px icon rail with a text
  label under each icon (主页, 看板…), and one rounded content card. Build on
  `components/app-shell.tsx`; no reUI App Shell blocks.
- **R-36** Bots use bloub avatars (`BotAvatar`, Figma `196:3571`, all 16
  shapes kept); people use letter avatars.
- **R-37** Animate only when the user's action changes a size or position.
  Position and size move with springs; opacity and colour use a duration.
- **R-38** Light-theme hover and column backgrounds use `rgba(0,0,0,a)`
  overlays, not a tinted overlay (an `rgba(16,24,40,…)` overlay read as mint
  green).

## Copy

- **R-40** No filler or explanatory copy in the UI (口水话; Alex repeated
  this on 2026-10-23 and 2026-10-24). If a sentence only explains the screen
  or narrates state, remove it. Examples that were removed: 「谁在工作 · 1 个
  agent 正在处理任务」 above the composer, 「和你的 Coordinator 聊聊」,
  「有值得看的会第一时间放到这里」.
- **R-41** An empty state is one colloquial line plus one button (often
  "send to a bot"). Never "这里是空的" or "Check back later".
- **R-42** Every visible string lives in `messages/zh-CN.json` and
  `messages/en.json`; `pnpm i18n:check` must pass. Write Chinese first.
- **R-43** Use the glossary's words: Bot, 对话, 线程. Never 会话 for a left
  row or a run. Built-in role names stay English (Coordinator).
- **R-44** The home greeting stays 「早上好，Alex」 (time of day + name).

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

The drift rows are open in `decisions.md`. Until they are settled, the code
value is what ships and Figma is updated to match.
