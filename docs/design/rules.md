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
- **R-06** The Coordinator is a bot. Its avatar is a bloub (ink with an orange
  star), never the letter C.
- **R-07** Action entry points (buttons, menu items, the collapsed sidebar
  toggle, the 新建任务 dialog header) never say "Coordinator". Conversation
  headers keep the centred Coordinator pill.

## Chat

- **R-10** There is one composer: the centre composer used by the Coordinator
  chat (Grok style, attachment button). The right panel never has an input
  box. Every instruction, including one about a thread or a screen, goes
  through the centre composer.
- **R-11** The composer has no model picker. The model is our default;
  BYOK users will choose it in Settings later.
- **R-12** No starter or suggestion cards in any chat ("试试从这些事情开始").
  Suggestions live only in the 建议 list. A new bot greets with one bubble
  and an A–D choice card.
- **R-13** One-to-one chats (a bot, the Coordinator, the board's Coordinator
  sidebar) show no avatar or name on messages; the header pill names the bot.
  Group chats show a 24px avatar on the left at the bottom of each run and
  the name once per run, 12px Medium in the bot's colour (Figma `205:4488`).
- **R-14** Bot text uses the same bubble as the user's. Charts, OpenUI cards
  and choice cards have no bubble. Bordered cards (document, computer) sit
  below the text bubble, never inside it.
- **R-15** A task mentioned in chat is an inline chip with the board's status
  icon, not a large card.
- **R-16** The computer card in chat shows a title, a status, one sentence
  about the task and a big screen. Approval is part of that card. It never
  shows an operation log, a step checklist, or OS and spec lines.
- **R-17** The caption under a bot's screen is 「<Bot 名> 的屏幕」 and nothing
  else.

## Suggestions, tasks and devices

- **R-20** The 建议 list holds only notifications from connected apps'
  webhooks (Gmail, Notion, Slack, GitHub, Linear…) that the decision model
  judged worth showing. The Coordinator never writes into it. Its own ideas
  go in its chat.
- **R-21** With a bot selected, the right panel shows 建议 on top, that bot's
  threads below, then 我的任务.
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
- **R-25** Board cards show status, priority and the assignee's avatar only,
  never names. The board is the reUI Kanban.
- **R-26** Workspace tasks sync with Linear (`MIK-xx`); personal tasks stay in
  Mikka. Teammates see agent runs on workspace issues only, never left-column
  chats or private memory.

## Look

- **R-30** Greys are pure neutral: `rgba(0,0,0,a)` and `#737373 / #A3A3A3 /
  #171717` in light mode, the same idea in dark. Never slate, zinc or teal
  tinted. Main content is near-black (`text-foreground`); grey is for
  metadata, borders and hover only.
- **R-31** No white hairlines. Inputs have a grey fill and no stroke. The
  sources to watch: shadcn `border-input` (dark `--input` is
  `oklch(1 0 0 / 15%)`), `ring-foreground/10` on dialogs and popovers,
  Comma's 0.5px hairlines, and column `border-l/r`. Inputs are decided;
  the app-wide sweep is open in `decisions.md`.
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
- **R-36** Bots use bloub avatars (`BotAvatar`, Figma `196:3571`); people use
  letter avatars. (The Figma style guide's rule 8, "渐变球", predates bloub
  and is out of date.)
- **R-37** Animate only when the user's action changes a size or position.
  Position and size move with springs; opacity and colour use a duration.
- **R-38** Light-theme hover and column backgrounds use `rgba(0,0,0,a)`
  overlays, not a tinted overlay (an `rgba(16,24,40,…)` overlay read as mint
  green).

## Copy

- **R-40** No explanatory or filler copy in the UI (口水话). If a sentence only
  explains the screen, remove it.
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
| `accent/default` | `#2f6bff` | `--sidebar-primary` | shadcn blue | yes |
| `status/*` | StatusBadge set | `--success`, `--warning`, `--destructive` | Tailwind palette | check |

The drift rows are open in `decisions.md`. Until they are settled, the code
value is what ships and Figma is updated to match.
