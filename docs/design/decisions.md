# Decision log

One row per product or design decision Alex made. Add the row the day you
hear it, quoting where it was said. If a decision replaces an older one,
mark the older row ~~struck~~ and point to the new one; never delete rows.
When a decision becomes a standing rule, add it to `rules.md` and link the
rule id here.

Newest first.

## Decided

| Date | Decision | Rule | Replaces |
| --- | --- | --- | --- |
| 2026-10-27 | Mobile composer: the 「+」 sits inside the input field at its left end, not as a separate circle beside it (as in ChatGPT iOS). Alex: 「加号改在里边」 | — | — |
| 2026-10-27 | The briefing stays one bubble; only Hark's tone is adopted, not its one-bubble-per-item format, and no date label (「我只让你学他的口气…简报应该要写到一块儿…写到一个气泡里边」) | R-46 | Hark-style one bubble per item and date label (same day) |
| 2026-10-27 | No visible times in the chat or on cards; swiping right-to-left reveals each message's time, as in iMessage and ChatGPT (「不要在左上角写这个时间…用手从右往左滑…跟 iMessage 是有点像的」) | | Time label above messages; time in card headers |
| 2026-10-27 | The daily briefing takes Hark's form: a centred date label, then one bubble per item, each ending with a concrete offer (「你可以看看hark他怎么写的这个风格」) | R-46 | One long briefing bubble (same day) |
| 2026-10-27 | The Coordinator's voice is a warm, professional, orderly secretary; the briefing is natural sentences, not commands. 建议 drops the 例行事项 heading (the page title already says 建议). Chats leave clear space above the composer (「每日简报写得太生硬了…像一个有条不紊的秘书」「例行事项写在那里…合适吗」「内容跟输入框靠得有点太近了」) | R-46, R-45 | Command-style briefing lines |
| 2026-10-27 | Opening a thread pushes a new page with a back button, never a bottom sheet or minimised bar (ChatGPT and Claude open a task as a page). 记忆 is a Markdown summary page (headings, prose, lists) with an 提问或更新 input, as ChatGPT's 记忆摘要 (「不允许做成抽屉…都是进入一个新的页面」「记忆…应该做成 Markdown」) | R-15 | Thread bottom sheet and minimised bar; memory as a list of rows |
| 2026-10-27 | The daily briefing moves out of 建议: the Coordinator posts it in its chat every day at 08:00 local time, as verb-first lines with mention chips (decided in the briefing thread: 「简报挪到 coordinate 里面，早上8点定时发送就行」) | R-20, R-21 | Briefing card at the top of 建议; briefing told only when an item needs the person today |
| 2026-10-27 | Items are written as verb-first actions that name the person or object (Comma, ChatGPT precedent) (「是不是应该设计成以动词开头啊…你写的东西就是有头无尾」) | R-45 | 「有人问…」 style items |
| 2026-10-27 | After an item is handled, the Coordinator reports the result and asks about the rest of today's briefing (chips, one button per item, 不用了) (「处理完之后应该还有跟进的过程…你可以问一下剩下两条你要不要处理」) | R-20 | |
| 2026-10-27 | The 建议 briefing names each item as an inline mention chip (app icon + short label, as Comma's briefing does); tapping a chip opens that item. No 「去 Coordinator 处理」 link (「简报这一块，人家是加上了这个 mention block 的」) | R-21 | Plain briefing text with a link to the Coordinator |
| 2026-10-27 | Every icon must match what mainstream products use for the same function; memory is a book (ChatGPT), 建议 an inbox, 线程 a code window, 任务 a checklist. Design reviews are sent as an Artifact page, with 3× images (「图标是不是用错了…你要去思考一下，目前主流产品都用什么图标」「要用 artifact」) | R-71 | Lightbulb, sparkles and other unsourced icons |
| 2026-10-27 | A finished thread's check is green. PR states use GitHub's own colours: open green, draft grey, merged purple, closed red (「打勾可以用绿色」「PR 的颜色根据 GitHub 上来」) | R-62, R-66 | Grey check (same day) |
| 2026-10-27 | Mobile Settings rebuilt as a hierarchy with a cited precedent per row (`mobile.md` § Settings, Figma 07–07e): account → 个人资料, 工作区, 通知, 记忆, 已连接的 App, 外观, 语言, 版本, 退出登录. 记忆 is a settings page after all (ChatGPT, Claude precedent) | R-70 | Flat settings page; 「关于你」 in chat only (same day) |
| 2026-10-27 | Every setting must have a precedent in a comparable product, cited in the spec; settings are a hierarchy, never one flat page; no rows that tell the person what they already know (「每一项设置，都必须找到同类型产品已有的设置作为参考…如果同类产品没有这样做，那你这样做就是违规」「分级菜单，你不能拉通拍」「账户登录方式写个Google，你是有毛病吗」) | R-70 | |
| 2026-10-27 | Mobile Settings: profile, 工作区, 通知 (主动消息, 电脑在用时不推送到手机), 已连接的 App, 账户, 通用, 退出登录. What the Coordinator knows about the person is managed in the chat, not in Settings; no push-device list (「什么叫他妈“正在推送，不归我管”」「重新写设置页」) | | 「关于你」 and 推送设备 in Settings (same day) |
| 2026-10-27 | 建议 shows its items as one long list (icon, title, source and time per row), not cards per app (「卡片统一用最下面那种长方形形式」) | R-21 | Horizontal per-app cards (same day) |
| 2026-10-27 | Mobile cards have no outline: a card in the chat (proactive card, thread card) is a filled grey surface like the bubble, the way 建议's cards are filled; secondary buttons inside are white. Source icons are the apps' own coloured marks, never a glyph on a tinted square (「描边的话不好看」「直接用那个带颜色的图标不行吗」) | | Outlined cards; tinted-square source icons |
| 2026-10-27 | A thread is never drawn with its bot's bloub avatar: bots coordinate, threads do the work; a thread shows a status icon. The thread card has no step line under its name, only outputs as chips. Spinners are grey, colour is restrained. The mobile look follows the Claude app (header pill, status-icon session list, filter menu, New-thread pill) (「BOT 是不干事情的…左边居然用的是 BOT 的 blob 图像，这个是不对的」「下面的那些话不需要写在那上面」「用灰色就行，颜色要克制」「学习Claude的ui」). Bot text stays in its grey bubble (R-14, 「文字要用泡泡框住」) | R-62, R-66, glossary | Threads shown with the bot's avatar (2026-10-24); card step line (2026-10-25) |
| 2026-10-27 | Mobile navigation is a side drawer like the ChatGPT iOS app: opens on the Coordinator chat; drawer = Coordinator, 建议, 线程, 任务, then 置顶 and 最近 bots/chats; the 线程 screen follows ChatGPT's Codex screen (machine filter chips, sections, floating composer) (「对，就按抽屉结构改」) | | Three bottom tabs (proposed same day) |
| 2026-10-27 | Mobile: Expo builds both platforms, iOS ships first; the mobile visual design is native and drawn fresh, not the web look (「我们肯定先做 iOS」「原生肯定是要重新做呀」). Spec: `mobile.md` | | |
| 2026-10-27 | A push notification has no buttons; the Coordinator's proactive message in its chat is a card with buttons. Pushes go to every device at once; a setting can turn off phone pushes while the computer is open (「手机推送不带按钮，在消息里面带按钮…同时推，但是在开关里面保留选项」) | R-20 | Plain-text reminders (Comma) |
| 2026-10-27 | Proactive messages are an on/off switch in Settings (no user-facing budget setting). The Coordinator may switch it on or off when the person asks, only after their explicit confirmation. The person's profile (what Mikka knows about them) lives in Settings (「主动消息只是开关，不是额度」「要明确需要用户的明确授权」) | | |
| 2026-10-27 | The mobile app lives in the main repository under `apps/mobile` (「App 可以放到 Mobile，就是放到那个主仓库里面去」) | | |
| 2026-10-27 | Layer-1 scoring stays on the Decisions API: one call per item asks has_cost and irreversible (yes/no) and due (48h / week / later / none) and level (critical…low / unclear) as choices; code applies the floors; the Coordinator writes the message (「可以」) | R-20 | Single show/hide probability |
| 2026-10-27 | The Coordinator's bar follows Comma's proactive skill: tell the person only when they must act before the next 08:00 briefing, or an irreversible cost lands within a week; when unsure, stay quiet; snooze instead of dropping when the cap is spent (「可以，这套打分逻辑可以」) | R-20 | |
| 2026-10-27 | Events go to the Coordinator and only the Coordinator tells the person; every push comes from it, including the morning briefing (「信息应该发到 coordinator，就由 coordinator 发给我」) | R-20 | |
| 2026-10-27 | The daily 建议 briefing is generated at 08:00 local time; connecting an app still writes one at once (「每日简报应该是在当地早晨…八点钟」「立即生成一次，这个是没有错的」) | R-21 | "Once a day at the person's chosen time" (same day) |
| 2026-10-27 | Rate events with Comma's attention model (cost, due, reversible → critical/high/ask/normal/low, with code floors); critical/high/ask go to the Coordinator, normal stays in 建议; telling the person is capped at 5 a day, 30 minutes apart (「可以」). The panel keeps the name 建议, not Routines (「我不建议把Suggestion改为routine」); its briefing is generated once a day at the person's chosen time | R-20, R-21 | |
| 2026-10-27 | Follow Comma: important events are pushed into the Coordinator's chat, and 建议 keeps the briefing and 例行事项 for routine items (「它是在 coordinator…里，会把事件推上去，同时还会保留一个 routine。其实我觉得它这个设计挺好的」). The Coordinator always asks before acting on an event (「一是前者」) | R-20, R-21 | 建议 list as the only place events show (2026-10-23) |
| 2026-10-27 | The Coordinator is each person's proactive personal agent: it brings important connected-app events (mail, CI, reviews, assignments, finished runs) to the person in its own chat and asks whether to act (「coordinator 应该做得比较 proactive 一点」; references: Hark, Wabi). The mobile client is built with Expo (React Native) and centres on this chat. Autonomy and the 建议 list: see the next row up | R-20 | |
| 2026-10-25 | Keep the shell layout as it is: 72px icon rail with labels, conversation list, centre, full-height right panel, top search bar, white card on grey. Narrower rail, search in the list header, grouped list, floating right card and dropping the outer card were all proposed (after a look at ChatGPT's two-layer layout) and declined (「不用，我就要现在这个样子」). Conversation rows carry a status dot on the avatar (green working, orange needs you) instead of status text, and no 「置顶 ·」 prefix | R-13 | |
| 2026-10-25 | Layout pass (「10条可以全修」, pending Alex's review of the artifact): board cards lose chip borders, no 「看板」 pill, 已完成 collapses beside the open sidebar; issue content centred up to 680px; same-minute events join; group 详情 lists members, recent threads and files, with no cloud computer (Alex: 「群聊用人不看电脑…没有加电脑之前的那种做法」); the avatar stays beside the bubbles at the bottom of a run (「icon 应该是跟我们的这些泡泡放在左边」) | R-13, R-25, R-61, R-63 | Bordered chips; left-aligned 560px issue column; a near-empty group 详情 |
| 2026-10-25 | One-to-one chats keep the grey bubble for a bot's text; an artifact, interactive chart or other rich card has no bubble (「一对一的聊天里，BOT回复应该是会说气泡…可以显示交互式图表的，是不需要气泡的」). The board's Coordinator sidebar was drawn without bubbles and with a different composer; fixed to match | R-14, R-10 | Board sidebar with bare text and a boxed composer |
| 2026-10-25 | A running thread is the same green badge with a dot everywhere (board card, thread list, thread card) | R-14, R-25, R-66 | Blue 「运行中」 on board cards |
| 2026-10-25 | A thread the Coordinator dispatches is a card under its reply (bot, name, status, one step line, outputs); clicking it opens the thread conversation in the centre, ‹ Coordinator goes back. One card per thread, updated in place (「交给 Codex 写代码…应该做成一种卡片的形式…点进卡片里面，进入到另外一个 chat 界面」) | R-15, R-66 | Run as an inline chip with the Codex icon |
| 2026-10-25 | Board cards keep labels, PRs and the latest run's state next to status, priority and avatar (option A over the slim option B, 「这个版本挺好的」); no column `+` | R-25, R-22 | Cards with status, priority and avatar only |
| 2026-10-25 | A global AI sidebar on every non-conversation page: top-right button, Coordinator by default, the current page as context (「方便我们把 AI 调出来…默认的话，我们一般选择 coordinator」→「我觉得这非常好」) | R-65 | Board-only Coordinator sidebar |
| 2026-10-25 | The user's chat messages are blue bubbles with white text; bots stay light grey (「用户发的信息能不能换成蓝色呀？」, accepted with the Figma page) | R-14 | Bot and user share one bubble (2026-10-24) |
| 2026-10-25 | The issue page follows Linear: assignee is a person with the bot handed the work under it; comments are bordered cards with replies inside; events are plain lines; @ a person or a bot, never a thread; talk to a thread by opening it on the right (「Linear的做法是应该被我们奉为瑰宝的东西」) | R-60–R-64, R-31 | Bot as assignee; comments as grey blocks; a 回复线程 chip in the comment box |
| 2026-10-25 | Input boxes go only where there is a conversation. The ban was about the thread list and the computer screen, which are not chats; an open thread is a conversation with its agent and ends in the standard composer (「那个地方根本不是聊天界面，但他写上去了…结果就变成了所有地方的右边都不能加输入框了」) | R-10 | "Right panel never has an input box" (2026-10-24) |
| 2026-10-25 | Any thread may edit the Figma file and the design docs; no single design thread owns them. New Figma work goes on its own page (「readme 相关的只由设计线程维护，你可以把它删掉」) | `README.md` | Figma owned by the design thread only |
| 2026-10-25 | Sign-in: Google button uses Google's official "G" mark; no scope or callback-URL notes under the OAuth buttons; divider reads "or" / 「或」 (「这个是假的」「删一下口水话」) | R-40 | "Or use email" divider |
| 2026-10-24 21:57 | Clef is fully replaced by the OpenAI Decisions API, including the first auto-approval screen (「10月22日那个东西已经过时了，已经完全换成了 OpenAI 的 decisions API」) | R-20 | Clef (2026-10-22) |
| 2026-10-24 21:57 | Right panel = 建议 + 任务; 任务 = threads started by the orchestrator or a bot, all kept, not the board's issues; a clicked suggestion fills the composer, the bot dispatches a thread, and the item moves from 建议 down to 任务 | R-21 | 建议 / bot threads / 我的任务 (20:46); 任务 tab = flat board list (2026-10-23) |
| 2026-10-24 21:57 | bloub keeps all 16 shapes | R-36 | |
| 2026-10-24 21:57 | Task scope is two-way: a workspace task in Linear can be turned back into a personal one (「保持双向」); code in issue #184 | R-26 | "Once in Linear it can't revert" (2026-10-23, MIK-30) |
| 2026-10-24 21:51 | No filler or explanatory copy anywhere in the UI (口水话) | R-40 | |
| 2026-10-24 21:50 | The Coordinator has no special UI; it is a normal bot (no star, no badge, no special empty state) | R-06 | Coordinator bloub with an orange star |
| 2026-10-24 21:28 | Artifact hosting: files in Cloudflare R2; versions, permissions and share tokens in Neon. HTML renders in an iframe with `sandbox="allow-scripts"` (no `allow-same-origin`) and a strict CSP; no separate user-content domain. Share links at `app.aspectlylabs.com/mikka/a/<token>` (only me / workspace / anyone with the link; revocable; noindex). Markdown renders in-app, sanitized | | |
| 2026-10-24 21:13 | Right panel 详情 header = the selected bot (same bloub and name as the left row) + 「<Bot 名> 的屏幕」; thread names only in the thread list | R-02, R-17 | An earlier relay that put the run name in the header |
| 2026-10-24 20:43 | Bot chat = plain conversation, no starter cards; Coordinator avatar is a bloub (see 21:50); 新建 Bot dialog is Grok-sized (big preview, shapes above, colours below) | R-06, R-12, R-05 | |
| ~~2026-10-24 20:46~~ | ~~Right panel with a bot selected keeps 建议, then the bot's threads, then 我的任务~~ (replaced 21:57) | R-21 | |
| 2026-10-24 19:36 | Bots run only on Mikka's AI SDK harness; own `bots` table; 新建 Bot = shape, colour, name only | R-05 | Bots as rows in `agents` |
| 2026-10-24 19:20 | Machine picker: Mikka Cloud first and default, then 本机, then Remote control; Settings › 设备 uses the same groups | R-23 | |
| 2026-10-24 19:17 | Device online state = StatusDot on the icon, never a text badge | R-24 | |
| 2026-10-24 18:56 | Left = bot list, right = thread list, no "conversation list" (`glossary.md`, PR #175) | R-01 | "会话" in the nav v3 handoff (#88) |
| 2026-10-24 | ~~Right panel never has an input box~~ (narrowed 2026-10-25); one centre composer; no model picker; one-to-one chats without avatars; bubble rules | R-10, R-11, R-13, R-14 | |
| 2026-10-24 00:38 | Every bot has its own computer; no 新建云端电脑 entry | R-04 | |
| 2026-10-24 | Bot avatars are bloub animated blobs | R-36 | HeroUI gradient spheres (2026-10-22) |
| 2026-10-23 23:13 | "No Coordinator" applies only to action entry points; conversation headers keep the Coordinator pill | R-07 | An over-broad removal |
| 2026-10-23 22:47 | No task creation on the board; one 新建任务 dialog, one sentence, Coordinator writes the task | R-22 | Column `+` |
| 2026-10-23 | Figma decides layout; Comma decides look; build on Comma's app shell; no reUI App Shell blocks; reUI components wherever one exists | R-35, `README.md` | |
| 2026-10-23 | Light-theme greys pure neutral | R-30, R-38 | Slate-tinted overlays |
| 2026-10-23 | Suggestions list = external webhook notifications only | R-20 | Coordinator suggestions in the list |
| 2026-10-23 | UI is reviewed as one Artifact page; no filler copy; e2e only after Alex accepts the UI | `review-checklist.md`, R-40 | Screenshot attachments |

## Accepted Figma frames

Only these frames count as a source (file `zPe5LKycb2XuT1ivCLRw07`).

| Area | Section / frames | Accepted |
| --- | --- | --- |
| ~~Nav v3.1 shell~~ | ~~`48:2`~~ moved to 归档 2026-10-25; the shell is what PR #165 built (`components/app-shell.tsx`) | ~~2026-10-24~~ |
| Kanban v2 | `77:2`, frames `89:2`–`92:2` (updated 2026-10-25) | 2026-10-23 |
| Cloud computer | `102:65` | 2026-10-24 06:19 |
| Style guide | `98:2` | 2026-10-24 |
| 新建 Bot dialog | `195:3225` | in review |
| Group chat | `224:5023` (blue user bubbles; `205:4488` archived) | 2026-10-25 |
| Artifact viewer | `178:11626` | in review |
| Issue detail, threads and comments | page `220:5022`, frames `220:5023`, `220:5199` | 2026-10-25 |

## Open

Questions waiting on Alex. Move a row to "Decided" when he answers.

| Since | Question | Default until answered |
| --- | --- | --- |
| 2026-10-24 | Remove white hairlines app-wide (dialog and popover rings, column borders), not only inputs? | Inputs only |
| 2026-10-24 | Token drift between Figma and code (`rules.md` § Tokens): which side moves? | Code value ships, Figma follows |


## 2026-10-25: Retire standalone Agent generation

Alex clarified that the product chat entity is a Bot; the earlier standalone
Agent chat runtime is retired. Remove its new-generation entrypoints and input
behaviour. Preserve owner-scoped historical reads, shared Bot rendering/images,
and Claude Code/Codex/Cursor task execution harnesses. Harness names describe
execution layers, not extra user-facing Bots. This is a behavioural retirement,
not a shell/layout redesign; source correction: Alex 2026-10-25 23:40 UTC.
