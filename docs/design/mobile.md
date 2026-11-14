# Mobile app

- **Redesign:** Alex dropped the push drawer and accepted the tab-bar design after Comma on 2026-11-06 ([decision](decisions/2026-11-06-1300-ios-comma-tabs-accepted.md)); the frames are in [`mobile-comma-redesign.md`](mobile-comma-redesign.md). Later task navigation, title, icon and spacing decisions supersede the
  corresponding original frames, as described here.
- **Status:** implemented baseline; UI/UX acceptance tracked in [#1296](https://github.com/alexj11324/Mikka/issues/1296) (2026-11-05)
- **GitHub:** #1296
- **Figma:** `zPe5LKycb2XuT1ivCLRw07`; page `268:4750` is archived per #1296 and is not a design authority. Page `358:9186` is a reference to verify. Current main and accepted decisions govern; do not redesign from archived or unaccepted frames.
- **Owner thread:** `claude/mikka-mobile-tech-choice-jrtbd3`
- **Code:** `apps/mobile` (Expo SDK 58) on the server's `app/api/mobile/*`
  routes. Earlier Expo Web acceptance belongs to its recorded revision;
  native behavior requires its own compatible build and device evidence.

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

The system tab bar has **Bot · 任务 · 建议 · 设置** and a trailing search tab.
[Task-only navigation](decisions/2026-11-07-2045-tasks-only-threads-inside.md)
replaces the former 对话 / 线程 tabs and 线程 | 任务 segment. Chats, task
pages and task conversations push over the tabs, hiding the tab bar. New Bot
and group dialogs are form sheets. No tab has a count badge.

Every tab root has one centred native title, with actions grouped on the
right and an empty left side. The transparent header has no material slab
or hairline; content fades under the soft top edge on iOS 26, with a short
page-colour fade on earlier versions
([header decision](decisions/2026-11-08-0120-ios-header-like-comma.md)).

### Bot and workspaces

Bot has + on the right, opening 新建 Bot or 新建群聊. Pinned chats sit on
three-column tiles with stars. 正在工作, Bot and 群聊 sections follow, newest
first. A row opens the chat, long press shows its preview/menu, and a left
swipe exposes 置顶 and 隐藏; a full swipe pins. Chats and pins are not dragged.
Sections fold and hidden chats remain under 隐藏的聊天. Unread marks on chat
avatars remain. A downloaded update exposes 重启以更新.

Workspaces switch only in 设置 › 工作区, with a check on the current one.
编辑 changes their local order. The Bot bar has no workspace menu.

### Tasks and their conversation

任务 has filter and + in the bar. Its groups are **等待你 · 进行中 · 待办 ·
已完成**, with 已完成 initially folded. Each row shows its own state icon,
number, short title and date, plus a grey line for the reason, dispatching
Bot and schedule. A search hit or chat dispatch card also opens the task.

A task's detail has its number, title, property chips directly on the page,
description and **活动**, oldest first. The creation uses a muted dot and
each attempt its result icon on the continuous timeline. + 评论 opens the
web task for writing a comment. The status and priority row opens the same
authorized web detail, where the task’s existing permissions govern edits.

A task has **one conversation** joining every attempt oldest first. Opening
an attempt scrolls to its section, while opening the conversation normally
starts at its newest message. Attempt dividers name how the previous attempt
ended and who took over. The header is ← and the task title with the current
Agent below; the composer sends to the newest attempt. The first dispatch is
one muted line. A failed attempt shows its plain cause, with the raw code
under 详情 ([conversation decision](decisions/2026-11-07-2300-one-conversation-per-task.md)).

The hand belongs only to a task needing a reply, confirmation or review.
受阻 uses an octagon, 失败 a triangle, 运行中 a ring and 排队中 a clock.
An attempt waiting for the person uses pause, and never the hand. Each glyph
has its semantic system colour, with no status dot or badge
([icons](decisions/2026-11-07-2230-one-icon-per-task-state.md),
[colours](decisions/2026-11-08-0130-task-state-icon-colours.md)).
`features/tasks/components/task-icons.tsx` and `model/task-groups.ts` own
that native presentation. The API can retain older group fields; source
fallbacks do not establish that every legacy server meets the accepted state
contract.

### Chats

A chat's centred title is the Bot's avatar and name in a frosted-glass pill.
Tapping it opens Bot information. Back and the right-hand ⋯ are separate
glass circles; ⋯ holds up to five open tasks, 全部任务 and 资料. Messages
scroll under the header's soft edge.

A message has no drag gesture. Long press selects its words in place with
native handles. 添加到对话 leads the capsules above the composer and adds
the selection as a quote without sending. Reactions, 回复, 复制 and
选择文本 live in ⋯ under Bot replies and other members' group messages.
The person's own messages have no ⋯. The latest finished Bot reply also
shows a separate copy action
([chat decision](decisions/2026-11-08-1430-ios-chat-gestures-and-header.md)).
Reactions remain one per person and message, and a second tap removes one's own.

The Bot's replies use grey bubbles, and the person's use blue. In groups,
Bot messages also show their own name and avatar. @name selects who answers;
otherwise routing chooses. Dispatch cards identify tasks and open task detail.
The native composer and chat controls reuse the components catalogued in
[components.md](components.md).

A centred time separates message groups after a gap of at least 15 minutes
or a new day. Messages have no individual timestamps. `lib/chat-time.ts`
formats today, yesterday, weekday or date labels. Attachments
open from the composer's + into `ChatAttachmentCard`, with 相机, 照片, 文件
and the system paste-image control when available. The authenticated file
contract is in [chat-attachments.md](chat-attachments.md).

### Suggestions, plugins and search

建议 shows its source cards and items, opening the Coordinator chat to act.
插件 is pushed from 建议 or 设置, with 应用 | 技能 and system search. Search
is its own tab, grouping Bot, 群聊 and 任务; it reads tasks only while a query
exists. Task conversations appear through their task.

### Coding review

A coding task can carry `ReviewSummaryRow` under its title and on its chat
card. The native review screen and file diff support a comment batch,
attached failing checks, a general note and 发给 Agent, with a separate
批准合并 action. The accepted layout is
[the coding-workspace decision](decisions/2026-11-08-1230-coding-workspace.md).

Source is in `features/review/` and `app/task/[id]/review.tsx`. Its reads and
writes use the proposed `/api/tasks/:id/review*` adapter contract shared with
`lib/code-review/client.ts`; backend integration and native acceptance need
matching evidence before claiming the entire flow works.

### Spacing and controls

`apps/mobile/lib/theme.ts` owns the layout tokens. Page side margins are
20 pt, list rows have 15 pt vertical padding, blocks are 20 pt apart, and
sections 30 pt apart. Task group headers are plain secondary text on the
page. Properties sit as chips without a box
([spacing decision](decisions/2026-11-08-0200-mobile-spacing.md)).

System navigation, menus, switches, search and sheets use native controls.
Shared product content follows `apps/mobile/DESIGN.md`; Liquid Glass is for
controls. Every animation retains its Reduce Motion behavior. Device-only
scrolling, accessibility and keyboard behavior need native evidence.

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
| 隐私政策 | top; also available before sign-in | Opens the existing public `https://aspectlylabs.com/privacy` page |
| 删除账户 | 个人资料 | Opens the existing account settings through the signed web handoff; the web page owns deletion confirmation |
| 退出登录 | top, last | ChatGPT, Claude, Comma |
| Push not deliverable (only when it fails) | top, first | Comma iOS |

Left out: sign-in provider, push-device list, explanatory footers, counts.
Administration (members, teams, devices) stays on the web.

## Native first

Wherever iOS has a native control or behavior, the app uses it; we build our own only where nothing native exists
([2026-11-05-1230](decisions/2026-11-05-1230-ios-native-first.md)). Native today: the transparent stack header and its system
back swipe, the header's 更多 (`Stack.Toolbar.Menu`), in-place text selection
and the reply's ⋯ menu, the header search field (`Stack.SearchBar`), the model picker and 「+」 (SwiftUI
`Menu`), segmented controls (SwiftUI `Picker`), switches (`UISwitch`), the activity indicator, sheets (`formSheet` with
detents, `modal` page sheets), and the scroll views' bounce and momentum. The vendored beui kit is not used for any of
these.

What is still our own, and why:

| Control | Why it is ours |
|---|---|
| Message bubbles, event lines, the thread card (`components/chat.tsx`) | iOS has no chat transcript control. |
| Message press feedback and group times (`MessageRow`, `TimeSeparator`) | No message drag; a long press opens native selection. The row owns its press motion and the transcript places its time separators. |
| Reactions in the reply's ⋯ menu | `MessageMenu.ios.tsx` uses the native pull-down menu, with two `ControlGroup` rows of three reactions. Long press selects text. The web build keeps its accessible menu path. |
| The reply action row (copy · ⋯) | Not a system control; ChatGPT and Claude draw it the same way. |
| The composer (`Composer` in `features/chat/components/chat-composer.tsx`) | iOS has no chat composer; its text field is the system's `UITextView`. |
| Settings rows (`components/settings.tsx` `Row`) | Drawn as an inset grouped list; moving them to `@expo/ui` `Form` is a separate change. |
| Reactions, mention chips, cards (`cards.tsx`) | No system equivalent. |

Motion: `apps/mobile/lib/springs.ts` holds the one spring family (snap back ζ≈0.73, a new message
rising 8 pt at ζ≈0.8). Every animation keeps its Reduce Motion branch.

## Layout and states

To draw for each screen: empty, loading, normal, error, offline, dark mode,
large Dynamic Type. Plus:

- Coordinator chat: streaming reply, proactive card (unanswered / answered /
  snoozed), thread card (running / waiting / failed / done).
- Push: lock screen and banner, one per supported kind (mail, CI, run finished).
- Home: the chat list with the pinned bots on top, its sections, search, and 重启以更新.
- Tab bar: each tab without badges; 工作区 with 编辑.
- 任务: each filter and state, detail, chronological 活动 and the joined conversation.
- 建议: no apps connected (connect CTA), nothing today, briefing generating.
- Sign in: Google, GitHub (R-40 copy rules).

## Rules that apply

R-06, R-14, R-15, R-20, R-21, R-36, R-40. Later accepted navigation, title, glyph and spacing decisions apply as
linked in Where it lives. An accepted frame alone is not runtime evidence.

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
  A tap opens the proposal's card (`pendingActionId`), its task and attempt
  (`issueId`, `runId`) or the chat (`botId`), also when it launched the app.
  `apps/mobile/lib/push-route.ts` binds the notification to its account/server;
  a legacy run without a task retains the `/thread/:id` fallback.
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
- **Navigation:** tab roots are under `app/(tabs)`, with task detail at
  `/task/:id` and its conversation at `/task/:id/conversation`. An `attempt`
  parameter selects that section. Bot chats use `/bots/:id`, groups
  `/groups/:id`, and legacy taskless threads `/thread/:id`. `lib/navigate.ts`
  opens a chat over home and pushes task routes over the current screen.
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
- **任务:** a row opens native task detail. The + 评论 action hands off to
  the same task on the web through the existing authenticated handoff.
- **Lists:** 任务 and 建议 support pull to refresh. Data changes follow live
  invalidation; idle views add no polling.
- **Lost session:** a 401 signs the app out locally and shows sign-in with
  「登录已失效，请重新登录。」.
- **Sending:** a message that fails stays as its bubble with
  「未发送 · 重试」, and the composer keeps the words until the server takes
  them. 「没有网络」 shows under the header while offline.
- **Settings stored:** 主动消息 is lib/attention's switch
  (`attention_settings.enabled`); the push switches and 使用记忆 (off leaves
  the memory out of the prompt) are in `user_preferences`.
- **Attachments:** `ChatAttachmentCard` opens camera, library and file pickers.
  Bot, group and task composers pass an `attachmentScope`, upload through
  `/api/chat/attachments`, and send ready immutable file references with the
  text. Upload/retry/download and format limits follow
  [chat-attachments.md](chat-attachments.md). Native camera/library photos
  still use `pickImages` resizing before becoming scoped files. The legacy
  unscoped transport retains its two-image/text-file path in source.
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
