# Mobile app

- **Status:** draft (2026-10-27)
- **Linear / GitHub:** none yet
- **Figma:** page `268:4750` 「手机端 · iOS 初稿（Claude · 2026-10-27）」 in `zPe5LKycb2XuT1ivCLRw07`, frames 01–07 (in review)
- **Owner thread:** `claude/mikka-mobile-tech-choice-jrtbd3`
- **Code:** `apps/mobile` (Expo SDK 58) on the server's `app/api/mobile/*`
  routes; checked end to end with Expo web against a local server.

Decisions behind this spec are the 2026-10-27 rows in `decisions.md` and
R-20 / R-21 in `rules.md`.

## What the user does

「Mikka 在手机上是我的 personal agent。」The Coordinator tells me what needs me
(an important mail, a failed CI, a run that finished), asks whether to act,
and I answer or dispatch work in one tap or one sentence. I check the 建议
briefing in the morning and see what is waiting on me.

## Platform and stack

- Expo (React Native) with Expo Router, in the main repository at
  `apps/mobile`, using `@mikka/protocol` from the pnpm workspace.
- iOS ships first. Android builds from the same code later; Android pushes in
  mainland China need a vendor push service (FCM is not available there).
- Builds run on EAS, not on the developer's Mac (`AGENTS.md`).
- The visual design is native and drawn fresh for mobile. Web Figma frames
  and the Comma look (R-35) do not apply; the brand mark, bloub avatars
  (R-36) and the words in `glossary.md` do.

## Where it lives

The system tab bar holds **对话**, **线程** and the system search tab
([decision](decisions/2026-10-31-2345-mobile-bot-home.md),
[top bar and drawer](decisions/2026-11-01-0045-mobile-home-bar.md)); the app
opens on 对话. A chat, a thread, 设置, 插件, 建议 and 任务 open over the tabs,
with the system back button and edge swipe.

**对话** is a messaging app's chat list (Alex's Grok screenshot): no title and
no search field at the top. The person's avatar (top left) opens the
**drawer**: the person and workspace (→ 设置), 建议, 任务, 插件, 设置, and
「重启以更新」 once an update has downloaded
([decision](decisions/2026-10-31-2010-ota-updates.md)); a swipe right on a
tab's root opens it too. 「+」 (top right) opens 新建 Bot and 新建群聊. The
Coordinator is pinned on top with the bots the person pinned; 星标 = 置顶标记，
所有 bot 一致 (R-06). 现状（非决定）：the app keeps the Coordinator pinned and
draws the star only on it. Then every other bot and group chat with its last line and time,
newest first (the web bot list, R-01).
**搜索** is the tab bar's search: its field sits at the bottom and matches
bots and group chats by name.
The Coordinator gets no other special UI (R-06).

Controls are the system's where iOS has one
([decision](decisions/2026-10-31-2200-mobile-native-ios.md)): the top bar is
the iOS navigation bar with its own bar buttons, menus and back button;
the tab bar, capsules and the composer are Liquid Glass on iOS 26.

**线程** (the tab; like the Claude app's Code screen): grouped by state,
等你回复 · 进行中 · 失败 · 已完成; 新线程 and the filter menu sit in the bar.

- A thread row is a status icon, the thread name, and one grey line: the
  bot's name and a machine icon (cloud, laptop, server), never the machine
  as text. Only 等你回复 and 待审阅 add a word before the name; no 完成 or
  失败 word (the icon says it) and no failure reason. Never the bot's bloub avatar (glossary). Icons: grey
  spinner 进行中, hollow circle 等你回复, red alert 失败, green check 完成.
  A thread whose output is a PR shows the PR icon in GitHub's colours: open
  green (待审阅), draft grey, merged purple, closed red. Rows waiting on the person carry a blue unread dot on the right.
- 设备 chips at the top (Mikka Cloud, Mac, …); an online machine has a green
  dot (R-24). Tapping one filters the list.
- The filter button (top right) opens a menu: 全部 · 等你回复 · 待审阅 ·
  进行中 · 已完成 · 已归档.
- 新线程 (top right, beside the filter) opens the Coordinator's composer to
  dispatch work through it.

**Chat** (like the Claude app): the header is the bot's name in a glass
capsule, which opens the bot's page; 「…」 (top right) opens 资料 and that
bot's 线程. Dragging a message from left to right quotes it in the composer
(a reply arrow follows the finger; letting go past the mark quotes it, with a
tick); only a swipe from the screen's edge goes back. A bot's reply has 复制
under it. A long press on any message opens a system sheet: 回复 (quote it),
复制, and 选择文本 (the words, to select any part). The bot's replies sit in the grey bubble and the person's
in the blue one, as on the web (R-14). The
thread card is a status icon and the thread name, with outputs as chips
(R-66); no step line.

**新建 and groups**: 对话's 「+」 opens 新建 Bot (name, shape, colour; its
chat opens) and 新建群聊 (a name and its bots; the group opens). Groups sit in
对话 with the bots, newest first, a dot while unread. In a group the person's
messages are blue on the right and each bot's sit on the left under its name
and avatar; `@name` sends a message to that bot, else Mikka picks who answers.

**Reactions**: the long-press sheet opens with ❤️ 👍 👎 😂 🎉 🙏, one per
person per message (the same one again removes it); they show as chips under
the message with a count past one, and tapping one's own removes it.

**Bot page** (资料): the avatar and name, then what the web's right panel
shows beside the chat, as grouped lists: 线程 (the latest five, then 全部线程),
电脑 with its state (a bot's only; its screen opens on the web), PR (the PRs of
the tasks its threads worked on, each with 等待审查 / 进行中 / 已合并; opens on
GitHub), 资料库 (what its threads handed over; Markdown opens in the app, HTML
on the web) and 例行 (its scheduled tasks and when each runs next, or 已暂停).
A section with nothing in it is left out. On top sit two switches: 置顶 (the
bot joins the Coordinator in 对话's pinned row) and 通知 (off: no pushes from
this chat) ([decision](decisions/2026-11-01-0050-mobile-chat-settings.md)).

Message times are hidden. Swiping the chat from right to left reveals each
message's time on the right, as in iMessage and ChatGPT (Figma 01b); no time
labels above messages or inside cards, and no date label above the briefing:
it is one bubble (decisions 2026-10-27).

Colour is restrained: grey spinners; blue only for unread dots and send;
red only for failure; green for a finished thread and an online machine; PR
states use GitHub's colours.

Things waiting on the person have no screen of their own: proactive cards sit
in the Coordinator chat, and waiting threads
sort first on 线程.

A thread card in any chat (R-15) pushes the thread's own page (back button top
left returns to the chat), as ChatGPT and Claude open a task. No bottom sheet,
no minimised bar.

## The Coordinator's proactive messages

What reaches the person and when is R-20. On mobile:

- A proactive message is a **card** in the Coordinator chat: one or two
  sentences on what happens if nothing is done and by when, the source link,
  and buttons for the next step.
- Buttons: the concrete next step the message offers (e.g. 「起草回复」),
  「晚点再说」 (snooze; the Coordinator asks when, or picks before the
  deadline) and 「不用了」 (handled). Answering in text works too.
- The Coordinator never acts before the person taps or says yes.
- Every proactive message the Coordinator decides to send is also a **push
  notification**. The push has **no buttons**: tapping it opens the card.
- Verification codes (R-20): in the app chat and its push only; never to
  Telegram or Slack.
- The 08:00 briefing: every day the Coordinator posts it in its chat and
  pushes it: one verb-first line per item, each with a mention chip that
  opens the item (R-41).
- Follow-up: when a thread finishes an item, the Coordinator says what was
  done in one bubble, then lists what is left from today's briefing as
  mention chips and asks whether to go on, with one button per item and
  「不用了」 (Figma frame 08).

## Settings

Opened from 设置 in the drawer. A hierarchy (R-70): the
top screen holds categories, each opens its own page. Every row cites its
precedent. Figma frames 07, 07a–07e.

| Row | Where | Precedent |
| --- | --- | --- |
| Account: avatar, name, email → 个人资料 (photo, name; email read-only) | top → 07a | Comma iOS Account row → Profile; Claude (name + email); ChatGPT (avatar + name). None shows the sign-in provider |
| 工作区 | top → 07b | Comma iOS workspace picker; ChatGPT 工作空间 |
| 通知 (value 开/关) | top → 07c | ChatGPT, Claude, Comma (Comma shows On/Off on the row) |
| 主动消息 | 07c | Claude Code "Push when Claude decides"; Comma "Proactive messages" |
| 需要你决策 / 待审阅 / 线程完成 | 07c | Claude Code "Push when actions required"; Cursor (needs input, finished, ready for review); Replit; GitHub Mobile per-type toggles |
| 每日简报 | 07c | ChatGPT notifications "Tasks" (scheduled-task results) |
| 推送到手机: 立即 / 电脑不在用时 | 07c | Slack "Notify me on mobile" |
| 记忆: 使用记忆 toggle + 记忆摘要 row | top → 07d | ChatGPT 记忆 (Reference saved memories, Manage); Claude (Memory from chats, Manage) |
| 记忆摘要: one Markdown document (headings, prose, lists), updated time, 提问或更新 input at the bottom | 07d → 07f | ChatGPT 记忆摘要 |
| 已连接的 App | top → 插件 | Claude Connectors; ChatGPT 插件; Poke Integrations. Opens 插件 (below) |
| 外观 | top | Claude, ChatGPT, Comma Android |
| 语言 (opens iOS Settings) | top | Comma iOS |
| 版本 | top | Comma iOS Version; ChatGPT 关于. Shows the version, the build and, when an update is running, when it was published (「1.0.0 (6) · 10-31 22:51」) |
| 退出登录 | top, last | ChatGPT, Claude, Comma |
| Push not deliverable (only when it fails) | top, first | Comma iOS |

Left out: sign-in provider, push-device list, explanatory footers, counts.
Administration (members, teams, devices) stays on the web.

## Layout and states

To draw for each screen: empty, loading, normal, error, offline, dark mode,
large Dynamic Type. Plus:

- Coordinator chat: streaming reply, proactive card (unanswered / answered /
  snoozed), thread card (running / waiting / failed / done).
- Push: lock screen and banner, one per kind (mail, CI, run finished,
- 对话: the bot list with the Coordinator pinned, search, and 重启以更新.
- Drawer: open over the Coordinator chat, with unread dots.
- 线程: each filter, running / waiting / failed / done rows.
- 建议: no apps connected (connect CTA), nothing today, briefing generating.
- Sign in: Google, GitHub (R-40 copy rules).

## Rules that apply

R-06, R-14, R-15, R-20, R-21, R-36, R-40. New rules this spec needs once Alex
accepts the frames: proactive card with buttons, push without buttons,
mobile tabs.

## Engineering

- **Sign-in:** better-auth's Expo plugin (`expo()` in `lib/auth.ts`, the app's
  scheme `mikka://` is a trusted origin). Google and GitHub open the system
  browser; email and password work too. The session cookie lives in the
  keychain and goes with every request. Still to check on a device: that the
  OAuth proxy hub (`BETTER_AUTH_OAUTH_PROXY_URL`) returns to `mikka://`.
- **API:** `app/api/mobile/*`, one route per screen: `home` (对话),
  `chat` (Coordinator or a bot; `?bot=`), `threads`, `threads/:id`, `tasks`,
  `settings`, `preferences`, `push-tokens`. 建议 uses `/api/suggestions`.
  Writes refuse a browser Origin other than the site's own. The chosen
  workspace travels as the web's `mikka-workspace` cookie.
- **Push:** Expo Push Service. `mobile_push_tokens` holds one token per
  installed app, removed on sign-out. A Coordinator or bot reply to Mikka's own
  events (never to the person's message, never a quiet reply) is pushed when
  the settings allow it: 需要你决策 for events that need the person (handed-over
  matters included), 线程完成 for finished runs, 每日简报 for the 08:00
  briefing (`lib/push-reasons.ts`, `lib/mobile-push.ts`). A verification code
  stays in the app chat; its push only says one came. A card is pushed as its
  words (`lib/openui-lang.ts`). Registering needs the EAS project id
  (`extra.eas.projectId`, set from `EAS_PROJECT_ID` by `app.config.ts`) and a
  real device. The app asks iOS after the Coordinator's first message of its
  own or from 通知, never at launch; denied or failed shows 「推送无法送达」.
  A tap opens the proposal's card (`pendingActionId`), the finished thread
  (`runId`) or the chat (`botId`), also when it launched the app.
- **Cards and proposals:** OpenUI replies are drawn natively
  (`components/OpenUI.tsx`: text, choice and question cards, approval,
  follow-ups, buttons, and the image cards `BeCardGrid`, `BeImageCard` and
  `BeImage`). Image cards find their picture as the web does, through
  `GET /api/agent/images` (`lib/images.ts`): grey 16:9 while looking, the card
  without a picture when there is none or the lookup fails, and the Wikimedia
  Commons credit under 图片来源与许可. A grid is one column on a phone, as the
  web's grid is below 26rem. A card the app cannot draw shows its words and
  「在网页上打开」, which opens the same chat on the web signed in
  (`app/api/mobile/open`, a one-minute single-use token). The browser first
  shows the target account and requires a same-origin, browser-bound confirmation;
  following the link alone never changes its signed-in account. Proposals from
  `/api/pending-actions` sit at the end of every chat with 不要 and
  发送/保存到日历 (`POST /api/mobile/pending-actions/:id`).
- **Navigation:** routes are `/chats` and `/threads` (the tabs), `/bots/:id`
  (a chat; `coordinator` for the Coordinator's), `/bots/:id/info`,
  `/bots/:id/threads`, `/thread/:id`. 新线程, a 建议 item and a push about a
  chat open the chat over 对话 with the stack started over there
  (`lib/navigate.ts`), so Back returns to the bot list; a thread card or a push
  about a thread pushes the thread over what is open.
- **Composer:** one field: the quote (when one is set), the words, then a row
  with 「+」, a slot beside it (the model menu) and send. A quote is sent ahead
  of the words as Markdown quote lines and drawn dimmed above them in the
  person's bubble.
- **插件:** a system segmented control switches 应用 and 技能, as the web's
  tabs. 应用 lists what the person connected, then 热门 (Mikka's own GitHub,
  Linear and Telegram first) and 新品推荐 from the store
  (`/api/integrations/composio/catalog`), and searches every app. A row opens
  that app's web page signed in (`/?section=plugins&app=<id>`, through the
  one-time-token handoff), where 连接 and 管理 run: the provider's sign-in and
  Composio's callback need the browser session, which the app's keychain
  cookie is not. The list reloads when the browser closes. 技能 is skills.sh's
  leaderboard and search (`/api/skills/search`), a page at a time; a row opens
  the skill on skills.sh.
- **Workspace:** switching it in 设置 reloads every screen's data at once.
- **任务:** a row opens the task on the web, signed in (`/?issue=<id>`).
- **Lists:** 线程, 任务 and 建议 pull to refresh.
- **Lost session:** a 401 signs the app out locally and shows sign-in with
  「登录已失效，请重新登录。」.
- **Sending:** a message that fails stays as its bubble with
  「未发送 · 重试」, and the composer keeps the words until the server takes
  them. 「没有网络」 shows under the header while offline.
- **Settings stored:** 主动消息 is lib/attention's switch
  (`attention_settings.enabled`); the push switches and 使用记忆 (off leaves
  the memory out of the prompt) are in `user_preferences`.
- **Attachments:** the composer's 「+」 opens a sheet from the bottom, as in
  the Claude app: 相机, 照片 (up to two per message) and 文件 (text files) as
  tiles; the picker opens over it and the sheet closes after. Photos are re-encoded as JPEG under
  the server's 1 MB limit and sent as `images` with `POST /api/mobile/chat`;
  a text file goes into the message as its contents under its name, as on the
  web. Chat items carry `images` (a count) and the app loads each photo from
  `GET /api/mobile/chat/image?message=<id>&index=<n>`, which serves only the
  person's own messages.
- **现状（非决定）:** not on the server yet, so the app leaves them out: 待审阅 and 已归档
  threads, pinned bots, 电脑不在用时 (needs the web to report presence),
  dictation (so the composer has no mic yet), dark mode.
- **App icon:** the Mikka mark, the same file as the desktop app's
  (`apps/mobile/assets/icon.icon`, Icon Composer; `icon.png` is the opaque
  1024 fallback). A new icon needs a new build.
- **Updates:** EAS Update for JavaScript changes; store releases for native
  changes.

## Out of scope (first version)

- Android release.
- The board (kanban), issue editing beyond status and assignee, Tiptap
  editing.
- A bot's computer screen.
- Device and daemon management; most of Settings stays on the web.
- Watches on sources without webhooks (polling), pending Alex's decision on
  watches.

## Done when

- `docs/review-checklist.md` passes on the Figma frames, and Alex accepts
  them (listed in `decisions.md`).
- A TestFlight build signs in, shows the Coordinator chat, receives a real
  proactive push from a real event, and the card's buttons dispatch a thread.
