# Mobile app

- **Redesign:** Alex dropped the push drawer and accepted the tab-bar design after Comma on 2026-11-06 ([decision](decisions/2026-11-06-1300-ios-comma-tabs-accepted.md)); the frames are in [`mobile-comma-redesign.md`](mobile-comma-redesign.md). The shell, 对话, 线程 / 任务, 建议, 插件, 设置 and the 新建 sheets follow the frames.
- **Status:** implemented baseline; UI/UX acceptance tracked in [#1296](https://github.com/alexj11324/Mikka/issues/1296) (2026-11-05)
- **GitHub:** #1296
- **Figma:** `zPe5LKycb2XuT1ivCLRw07`; page `268:4750` is archived per #1296 and is not a design authority. Page `358:9186` is a reference to verify. Current main and accepted decisions govern; do not redesign from archived or unaccepted frames.
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

The app is the system tab bar with four tabs, **Bot · 任务 · 建议 · 设置**, and a
search tab at its trailing end
([decision](decisions/2026-11-06-1300-ios-comma-tabs-accepted.md); tab names and
the 任务 tab since [2026-11-07](decisions/2026-11-07-2045-tasks-only-threads-inside.md)).
Lists show tasks only; a thread opens from its task's 活动, pushed over the task.
The Bot tab's large title sits in the top bar's own row with a **+** on the right
(新建 Bot, 新建群聊); there is no workspace menu, and workspaces switch only in
设置 › 工作区. The 任务 tab groups its tasks 等待你 · 进行中 · 待办 · 已完成; each row carries its
own state's icon, the raised hand only for 等你处理
(a task has one conversation, and every tab's title sits in the top row: [2300](decisions/2026-11-07-2300-one-conversation-per-task.md))
([states and icons](decisions/2026-11-07-2230-one-icon-per-task-state.md)), and no coloured dots; its + creates a task. The
paragraphs below on the 对话 bar's workspace menu and on the 线程 tab and its
segment are replaced by this. Each tab is
its own Stack with a large title. A chat and a thread open over the tabs, so the
tab bar hides there. 新建 Bot and 新建群聊 open as form sheets. 线程 and 建议 show
their counts as the system's tab badges.

**对话** (designs 01–05) is a messaging app's chat list under the large title 对话.
- The bar holds the workspace menu (left: the workspaces with a check on the open
  one, 编辑顺序, 工作区设置) and 新建 (right: 新建 Bot, 新建群聊).
- The pinned chats sit on top as tiles, three to a row, each with a star. The star is the pin,
  the same for every bot; the Coordinator is pinned until the person unpins it
  ([decision](decisions/2026-11-01-1215-star-is-the-pin.md)). An orange dot on a
  tile is a thread waiting on the person; a blue number is unread messages.
- Then come the sections 正在工作, Bot and 群聊. Each row has its last line and
  time (a working bot says 进行中), newest first (the web bot list, R-01; R-06).
  Rows have no separators; the pressed surface sits 10 pt in from each side.
- Each chat row taps open with the system's link transition. A long press opens its menu over a live preview. A
  swipe left shows two capsules, 置顶 and 隐藏, and a full swipe pins. Chats cannot be dragged to reorder (Alex, 2026-11-07)
  ([decision](decisions/2026-11-05-2010-ios-home-list-interactions.md)). Sections fold. The unread count or waiting
  mark sits on the right under the time. Hidden chats are listed under 隐藏的聊天 at the foot.
- 「重启以更新」 shows above the list once an update has downloaded
  ([decision](decisions/2026-10-31-2010-ota-updates.md)).

**工作区** (design 19, 设置 › 工作区, also 编辑顺序 in the workspace menu) lists the
workspaces with a check on the open one; a tap switches and goes back. 编辑 shows
handles that arrange them on this device.

**Side margins** (Alex 2026-11-06, HIG layout margins; `lib/theme.ts`): a plain list's content starts 16 pt in from
each edge (对话, 线程, 任务, 建议, 搜索), an inset grouped list's cards 20 pt (插件, 工作区, the 新建 sheets).

**No badges** (Alex 2026-11-06): the tab bar carries no count badges, and thread and task rows no coloured status
dots; the list's sections name the state. The unread mark on a chat's avatar stays.

**Short titles** ([decision](decisions/2026-11-06-1400-task-short-titles.md)): a task, and every thread that works on
it, is listed by the short title the small model wrote when the task was created, while the task keeps that title.

**线程** (designs 13, 15) has a 线程 | 任务 segment under its large title, then one list. Each row is one line: the
status icon and the title, at 17 pt, cut with an ellipsis; a title's leading issue key (ALEX-12, #1408) and trailing
date or time are not shown (Alex 2026-11-06, `lib/display-title.ts`). A floating glass switcher above the tab bar
filters 全部 / 等待你 / 进行中 / 已解决; it is the only filter. 任务 lists the tasks the same way, each opening on the web.

**建议** (design 16) has a card per app with today's count, then 今天; 插件 is its bar button. **插件** (design 17) is
pushed inside the 建议 and 设置 tabs: system search, 应用 | 技能, inset groups, a green dot for a connected app.

**搜索** (design 20) is the search tab: the system search field matches bots, group
chats and threads by name. It reads the thread list only while there is a query.
The Coordinator gets no other special UI (R-06).

Controls are the system's where iOS has one
([decision](decisions/2026-10-31-2200-mobile-native-ios.md)): the top bar is
the iOS navigation bar with its own bar buttons, menus and back button;
capsules and the composer are Liquid Glass on iOS 26.

**线程** (a tab, a large-title page; like the Claude app's Code screen): grouped as on the
web (R-52), 等待你 · 进行中 · 受阻 · 空闲 · 已解决, a task's attempts folded
into its newest thread (「第 N 次尝试」); 新线程 and the filter menu sit in the bar.

- A thread row is a status icon, the thread name, and one grey line: the
  bot's name and a machine icon (cloud, laptop, server), never the machine
  as text. Only 等你回复 and 待审阅 add a word before the name; no 完成 or
  失败 word (the icon says it) and no failure reason. Never the bot's bloub avatar (glossary). Icon: a speech
  bubble with the state as a dot on its corner, as on the web: pulsing grey 进行中, red 受阻, orange 等待你,
  hollow ring 空闲, green 已解决; the icon names its state for the screen reader. A circle is always a task
  ([decision](decisions/2026-11-04-2220-task-circle-thread-bubble.md)); the icon follows the row's group (R-52),
  never the run's raw status.
  A thread whose output is a PR shows the PR icon in GitHub's colours: open
  green (待审阅), draft grey, merged purple, closed red. Rows waiting on the person carry a blue unread dot on the right.
- 设备 chips at the top (Mikka Cloud, Mac, …); an online machine has a green
  dot (R-24). Tapping one filters the list.
- The filter button (top right) opens a menu: 全部 · 等待你 · 进行中 ·
  已解决 (待审阅 and 已归档 wait for the server to track them).
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
bot joins 对话's pinned row, with the star; the Coordinator too) and 通知 (off: no pushes from
this chat) ([decision](decisions/2026-11-01-0050-mobile-chat-settings.md)).

Message times are hidden. Swiping the chat from right to left reveals each
message's time on the right, as in iMessage and ChatGPT (Figma 01b); no time
labels above messages or inside cards, and no date label above the briefing:
it is one bubble (decisions 2026-10-27).

Colour is restrained: a grey pulsing dot for work in progress; blue only for unread dots and send;
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

The 设置 tab. A hierarchy (R-70): the
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

## Native first

Wherever iOS has a native control or behavior, the app uses it; we build our own only where nothing native exists
([2026-11-05-1230](decisions/2026-11-05-1230-ios-native-first.md)). Native today: the stack header with the system
material and its back swipe, the header's 更多 (UIMenu via `Stack.Toolbar.Menu`), a message's long press (the system context menu), the header search field (`Stack.SearchBar`), the model picker and 「+」 (SwiftUI
`Menu`), segmented controls (SwiftUI `Picker`), switches (`UISwitch`), the activity indicator, sheets (`formSheet` with
detents, `modal` page sheets), and the scroll views' bounce and momentum. The vendored beui kit is not used for any of
these.

What is still our own, and why:

| Control | Why it is ours |
|---|---|
| Message bubbles, event lines, the thread card (`components/chat.tsx`) | iOS has no chat transcript control. |
| Swipe right to quote, swipe left for times (`TimedRow`, `useTimeReveal`) | Messages' gestures are not public API; ours follow them, on `lib/springs.ts`. |
| Reactions in the long-press menu | A long press on iOS is the system context menu (`components/MessageMenu.ios.tsx`, `@expo/ui` `ContextMenu`), lifting the bubble itself. iOS has no reaction bar on a context menu, so the six reactions are two compact `ControlGroup` rows of three at its top. VoiceOver, the keyboard and the web build keep the actions sheet (`app/message.tsx`). |
| The reply action row (copy · 回复 · 更多) | Not a system control; ChatGPT and Claude draw it the same way. |
| The composer (`Composer` in `components/ui.tsx`) | iOS has no chat composer; its text field is the system's `UITextView`. |
| Settings rows (`components/settings.tsx` `Row`) | Drawn as an inset grouped list; moving them to `@expo/ui` `Form` is a separate change. |
| Reactions, mention chips, cards (`cards.tsx`) | No system equivalent. |

Motion: `apps/mobile/lib/springs.ts` holds the one spring family (snap back ζ≈0.73, a new message
rising 8 pt at ζ≈0.8). Every animation keeps its Reduce Motion branch.

## Layout and states

To draw for each screen: empty, loading, normal, error, offline, dark mode,
large Dynamic Type. Plus:

- Coordinator chat: streaming reply, proactive card (unanswered / answered /
  snoozed), thread card (running / waiting / failed / done).
- Push: lock screen and banner, one per kind (mail, CI, run finished,
- Home: the chat list with the pinned bots on top, its sections, search, and 重启以更新.
- Tab bar: each tab, with and without badges; the workspace menu and 工作区 with 编辑.
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
- **现状（非决定）:** thread filters 待审阅 and 已归档, and dictation remain outside the implemented first-version flow. Pins are implemented. Appearance follows the system ([decision](decisions/2026-11-02-1410-mobile-follows-system-appearance.md)); changing the native appearance configuration requires a compatible EAS build.
- **App icon:** the Mikka mark, the same file as the desktop app's
  (`apps/mobile/assets/icon.icon`, Icon Composer; `icon.png` is the opaque
  1024 fallback). Two layers on the dark fill: the lit dots (Liquid Glass,
  specular) and the unlit dots (white at 14%), so iOS 26 draws the default,
  dark, tinted and clear looks itself; actool also writes flat icons for
  earlier iOS. `.github/workflows/app-icon.yml` compiles it for iOS and macOS
  and renders each look on a pull request. A new icon needs a new build,
  dispatched by hand (`mobile-native.yml` does not watch `assets/`).
- **Updates:** `.github/workflows/mobile-update.yml` publishes JavaScript to the production OTA channel on main. Native configuration changes use `.github/workflows/mobile-native.yml`: exact-commit main CI, a completed EAS iOS build, then submission of that exact build id to App Store Connect/TestFlight. The workflow's automatic path filters cover `app.json`, `app.config.ts` and `eas.json`; native dependency or asset changes outside those filters need manual dispatch on main. A different runtime needs a compatible binary. TestFlight processing, installation and device acceptance remain separate from publication; see `apps/mobile/README.md`.

## Out of scope (first version)

- Android release.
- The board (kanban), issue editing beyond status and assignee, Tiptap
  editing.
- A bot's computer screen.
- Device and daemon management; most of Settings stays on the web.
- Watches on sources without webhooks (polling), pending Alex's decision on
  watches.

## Done when

- `docs/review-checklist.md` passes against the implemented screens and accepted decisions; #1296 authorizes autonomous audit, fixes, merge and deployment.
- Docker Expo Web evidence covers narrow screens, empty/loading/error states, keyboard access, dark/high-contrast appearance and relevant functional flows. Native-only behavior is identified separately.
- A compatible TestFlight build signs in, opens the chat list and chat, receives a real proactive push from a real event, and the card's buttons dispatch a thread. VoiceOver, Dynamic Type, UIKit navigation, haptics and Reduce Motion need real iOS evidence.
- The release record distinguishes web/API deployment, EAS OTA and native build/installation. Production failures return to Docker for reproduction, repair and regression before redeploying.
