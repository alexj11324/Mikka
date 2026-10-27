# Mobile app

- **Status:** draft (2026-10-27)
- **Linear / GitHub:** none yet
- **Figma:** page `268:4750` 「手机端 · iOS 初稿（Claude · 2026-10-27）」 in `zPe5LKycb2XuT1ivCLRw07`, frames 01–07 (in review)
- **Owner thread:** `claude/mikka-mobile-tech-choice-jrtbd3`

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

A side drawer, like the ChatGPT iOS app; no bottom tabs. The app opens on the
Coordinator chat. The menu button (top left) slides the drawer in from the
left and pushes the current screen right.

Drawer, top to bottom:

| Part | 中文 | What it holds |
| --- | --- | --- |
| Fixed rows | Coordinator · 建议 · 线程 · 任务 | Coordinator chat (first row, unread dot); 建议 (08:00 briefing and normal items, R-21); 线程 (every thread); 任务 (list only, no board) |
| 置顶 | 置顶 | Pinned bots and group chats |
| 最近 | 最近 | The other bots and group chats, newest first (the web bot list, R-01) |
| Bottom | 新建 · avatar | New bot or chat; the avatar opens Settings |

The Coordinator is the first ordinary row in the drawer and the default
screen; it gets no other special UI (R-06).

**线程 screen** (like the Claude app's Code screen):

- A thread row is a status icon, the thread name, and one grey line (状态 ·
  bot · machine or PR). Never the bot's bloub avatar (glossary). Icons: grey
  spinner 进行中, hollow circle 等你回复, PR icon 待审阅, red alert 失败, grey
  check 完成. Rows waiting on the person carry a blue unread dot on the right.
- 设备 chips at the top (Mikka Cloud, Mac, …); an online machine has a green
  dot (R-24). Tapping one filters the list.
- The filter button (top right) opens a menu: 全部 · 等你回复 · 待审阅 ·
  进行中 · 已完成 · 已归档.
- Bottom: a search button and a 「新线程」 pill, which opens the composer to
  dispatch work through the Coordinator.

**Chat** (like the Claude app): the header is the bot's name in a pill; the
right button opens that bot's threads and carries a blue dot when one waits
on the person. The bot's replies sit in the grey bubble and the person's
in the blue one, as on the web (R-14). The
thread card is a status icon and the thread name, with outputs as chips
(R-66); no step line.

Colour is restrained: grey spinners and checks; blue only for unread dots
and send; red only for failure; green only for an online machine.

Things waiting on the person have no screen of their own: proactive cards sit
in the Coordinator chat (unread dot on its drawer row), and waiting threads
sort first on 线程.

A thread card in any chat (R-15) opens the thread conversation full screen;
back returns to the chat.

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
- The 08:00 briefing: a short message and push only when an item needs the
  person today; otherwise it sits in 建议.

## Settings

| Setting | 中文 | Behaviour |
| --- | --- | --- |
| Proactive messages | 主动消息 | On / off. Off stops proactive cards and pushes; replies and reminders the person asked for still work. The Coordinator may turn it on or off when asked, only after the person confirms. |
| Phone pushes while the computer is open | 电脑在用时不推送到手机 | Off by default (push everywhere at once). On: no phone push while a Mikka web tab is open and active. |
| About you | 关于你 | The profile Mikka keeps about the person (accounts, what they own, what they work on now, where their work is reported, preferences, what is not theirs), each line with its evidence. Edit or delete any line. |

There is no budget setting; the caps in R-20 are fixed.

## Layout and states

To draw for each screen: empty, loading, normal, error, offline, dark mode,
large Dynamic Type. Plus:

- Coordinator chat: streaming reply, proactive card (unanswered / answered /
  snoozed), thread card (running / waiting / failed / done).
- Push: lock screen and banner, one per kind (mail, CI, run finished,
  briefing, verification code).
- Drawer: open over the Coordinator chat, with unread dots.
- 线程: each filter, running / waiting / failed / done rows.
- 建议: no apps connected (connect CTA), nothing today, briefing generating.
- Sign in: Google, GitHub (R-40 copy rules).

## Rules that apply

R-06, R-14, R-15, R-20, R-21, R-36, R-40. New rules this spec needs once Alex
accepts the frames: proactive card with buttons, push without buttons,
mobile drawer.

## Engineering prerequisites

- **Push:** Expo Push Service (APNs on iOS). Store device push tokens per
  person and device; remove them on sign-out. One "tell the person" decision
  (R-20) fans out to the app chat, every registered device, and, when
  configured, Telegram / Slack.
- **Presence:** the web app reports when a tab is open and active, for the
  「电脑在用时不推送到手机」 setting.
- **Sign-in:** better-auth's Expo plugin. Check that the OAuth proxy hub
  (`BETTER_AUTH_OAUTH_PROXY_URL`) returns to the app's deep link.
- **Chat:** AI SDK `useChat` with `expo/fetch` for streaming; card actions
  call the same server endpoints the web uses.
- **Updates:** EAS Update for JavaScript changes; store releases for native
  changes.
- **Backend this depends on:** the 08:00 briefing schedule
  (`claude/suggestions-cloudflare-cron`) and attention scoring and routing
  (`claude/coordinator-attention`).

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
