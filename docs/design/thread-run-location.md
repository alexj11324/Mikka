# Where a thread runs, and reviewing its PR

This page preserves the accepted 2026-11-06 run-location and Artifact frames.
Later decisions govern navigation and task state presentation. Lists contain
[tasks only](decisions/2026-11-07-2045-tasks-only-threads-inside.md). A task has
[one conversation across attempts](decisions/2026-11-07-2300-one-conversation-per-task.md),
with chronological activity and an attempt link scrolling to its section.
Task rows use their own [state icons](decisions/2026-11-07-2230-one-icon-per-task-state.md)
and [semantic colours](decisions/2026-11-08-0130-task-state-icon-colours.md).
The older thread-list and iOS subtitle frames below are historical layout references.
The [2026-11-08 coding-review decision](decisions/2026-11-08-1230-coding-workspace.md)
also supersedes Part 2's PR-review layout with one dedicated review page,
a final whole-PR diff and a separate 发给 Agent action. That is an accepted
specification; frontend adapters and slots require a matching backend and
version-bound acceptance evidence.

The web implementation is `components/workspace/thread-run-place.tsx` and the
`thread-header` UI slot. `MachineDetails` displays the machine facts and copies
the sandbox ID. The older frame's Open computer action is not present in that
component. Mobile uses Expo / React Native in `apps/mobile`, with machine DTOs
in `apps/mobile/lib/thread-machine.ts`. Its task conversation screen follows
the later task-title/current-Agent header. The SwiftUI popover described by
the original frame is not an implementation instruction.

- **Status:** accepted with two changes (Alex, 2026-11-06): icons only in the title bar; an Artifact button that is always there
- **Figma:** file `zPe5LKycb2XuT1ivCLRw07`, page 「待 Alex 确认 · 线程运行位置与 PR 验收（2026-11-06）」 `1052:6875`
- **Owner thread:** run-location mark and hover card (web, desktop, iOS) in this
  thread; the PR review view goes to the Factory delivery thread once confirmed.

Screenshots of the key frames are in [`thread-run-location/`](thread-run-location/).

## What the user does

1. Sees where a thread runs (Mikka Cloud, their own computer, an SSH server)
   right after its title, and hovers (taps on iOS) to see which machine it is.
2. When a thread has a PR, opens it from the thread header or the task, checks
   the PR, CI, changes, evidence and criteria, then asks for changes or approves
   and merges as themselves.

## Part 1 · Run location

| Frame | Node |
| --- | --- |
| L1 Web, right-column thread, cloud mark hovered, light / dark | `1054:247` / `1055:220` |
| L2 Every location and state: header strip + hover card, plus the full-screen thread header, light / dark | `1055:334` / `1055:664` |
| I1 iOS thread page, subtitle with location, light / dark | `1056:1057` / `1056:1365` |
| I2 iOS tap on subtitle: cloud popover, light / dark | `1056:1142` / `1056:1450` |
| I3 iOS tap on subtitle: offline computer, light / dark | `1056:1262` / `1056:1570` |
| Parts: mark variants (`1054:77`), hover cards, icons | `1053:2` |

- **Icons only** (Alex, 2026-11-06: 「这些都只留图标，文字必须要 hover 上去才能看得见」).
  After the title come two icons and no text: the device type icon (lucide
  `Cloud`, `Laptop`, `Server`) with the StatusDot on its top right (R-24),
  then the Agent's mark. Hovering the device icon opens the card below; the
  Agent mark has a tooltip 「Claude Code · Mikka Frontend 派出」. The mark
  component's 「显示名称」 property is off in headers and on inside the identity
  dialog. The desktop app uses the same web view.
- **Hover card.** `HoverCard` (`components/ui/hover-card.tsx`),
  288 wide. Title row: icon, name, status as dot + word (R-87).
  - Cloud: ID (full E2B sandbox ID, mono, copy button), 模板 (`claude` / `codex`
    / `desktop`), 创建, and 停止 once ended. Action 「打开电脑」, or 「看桌面」 for
    the `desktop` template. Status 运行中 / 休眠 / 已停止 (from `thread_machines.state`).
  - Computer and server: 系统 (`platform` · `arch`), 主机 for SSH servers,
    上次在线 when offline. No action.
- **Cloud display name.** 「云电脑 <first 6 characters of the sandbox ID>」,
  for example 「云电脑 i8k2m3」. It is derived when the thread is read; the
  `devices` row keeps its locked name 「Thread computer」, so no column is added.
- **Original iOS frame.** The 2026-11-06 frame placed a machine symbol in the
  nav subtitle and opened a popover. The later task conversation header leads
  with the task title and current Agent, as recorded in
  [2026-11-07-2300](decisions/2026-11-07-2300-one-conversation-per-task.md).
- **Task list rows.** All top-level lists show tasks. A row uses its own
  task-state icon and grey reason line. An offline device is a blocked reason,
  with the task's octagon icon. See
  [the task-state decision](decisions/2026-11-07-2300-one-conversation-per-task.md#icons).

### Data

`getThreadMachine` in `app/actions/agents.ts` and
`GET /api/mobile/threads/:id/machine` use `lib/thread-machine-view.ts`.
The owner-only reader joins `agent_runs.deviceId` to `devices` and
`thread_machines` in a separate indexed read. It selects the newest run with
machine information, falling back to an earlier run while the newest has none.

`lib/thread-machine.ts` defines `kind` (`cloud / laptop / server`), `state`,
`name`, `platform`, `arch`, `hostname`, `lastSeenAt` and nullable `cloud`
(`sandboxId`, `template`, `createdAt`, `endedAt`). A local device's online
state uses existing presence checks. The web component reloads when run status
changes and introduces no request polling timer.

## Part 2 · PR review (Artifact window)

Built on the accepted acceptance page (decision
[2026-11-04-2200](decisions/2026-11-04-2200-factory-flow-like-warp.md)): the
existing Artifact window, the report on the left, the thread on the right.
The entry is called **Artifact** everywhere (Alex, 2026-11-06), the same
Artifact the product already has; a PR a thread delivers opens as its Artifact.

| Frame | Node |
| --- | --- |
| E1 Artifact button in the thread header, seven states with their tooltips, light / dark | `1058:1785` / `1058:1962` |
| L3 Thread finished: Artifact card under its last message, light / dark | `1067:4874` / `1067:5144` |
| C1 Bot chat: the completion notice carries the Artifact card, light / dark | `1067:5261` / `1067:5433` |
| E2 Entry on the task page (「需要你」 block → 查看 PR #1288), light / dark | `1060:4925` / `1060:5107` |
| P1 Waiting for review, light / dark | `1058:1115` / `1060:3115` |
| P1b 「查看改动」: the whole change set (`ThreadChangesPane`) | `1060:4332` |
| P2 「要求修改」: focus the thread composer with a 要求修改 chip | `1059:1528` |
| P3 Changes requested, fix run going on the same PR | `1059:2155` |
| P4 「批准并合并」: confirmation bar (`ApprovalBar`), light / dark | `1059:2796` / `1060:3516` |
| P5 Merging | `1059:3427` |
| P6 Merged | `1059:4049` |
| P7 Failed: merge refused (conflict), retry, light / dark | `1059:4682` / `1060:3924` |
| P7b Failed: checks did not pass, rerun | `1059:5314` |

- **Entry.** The thread header always has one Artifact icon button
  (`icon-sm`, `ArtifactIcon`), left of stop. Before there is anything it is
  disabled, tooltip 「Artifact · 线程完成后生成」; while the PR is prepared,
  「Artifact · 正在准备 PR」. Once there is one it opens the window (P1); a
  status dot on its corner says the state: amber 待你审 (on a subtle fill),
  grey 修复中 / 合并中, purple 已合并, red 受阻, each named in the tooltip
  (「Artifact · PR #1288 待你审」). It replaces 「Artifact · N」; several
  Artifacts open the existing list menu.
- **In the chat.** The thread's finishing message is followed by the existing
  `ArtifactCard` (title, 「Artifact · 待你审」); the bot's completion notice in
  its chat (and the Coordinator's) carries the same card. On the task, the
  existing 「需要你」 block's button reads 「查看 PR #1288」.
- **Report.** PR title and verdict badges (existing), then one card: 分支 with
  a GitHub link, 检查 as one status (4/4 通过) plus the check names in grey text,
  the commit; 改动 with the agent's one-paragraph summary and per-file rows
  (`FileDiff`, one open); 证据 thumbnails that open in the window; then the
  existing criteria and review findings.
- **Actions.** 要求修改 (focuses the composer on the right with a chip, as the
  earlier frame 9c; sending starts a fix run on the same PR), 批准并合并
  (confirmation bar with unverified items and 「以 @<login> 合并到 main」).
  Failure states name the reason and offer retry.

## Part 3 · Execution identity dialog

The shield button's 「执行身份与费用归属」 dialog (#1199,
`ThreadExecutionIdentity`) showed raw IDs. Redrawn with the same parts as the
hover card.

| Frame | Node |
| --- | --- |
| D1 Personal: everyone is you, one row; light / dark | `1065:3890` / `1065:4176` |
| D2 Team: someone else started it, a shared computer; light / dark | `1065:4344` / `1065:4633` |

- Agent, 模型 (with the routing reason in grey), 运行在 (the run-location
  mark, which opens the same hover card), 工作区 by name.
- People as avatar + name, 「你」 for the viewer. Requester, Bot owner,
  execution principal and output owner that are the same person collapse into
  one row that names the roles.
- 用到的资源: 「Claude 订阅 · <account>」, 「你的 E2B key ····<last 4>」, a
  device by name with 「工作区分享」 when shared, 「工作区的 Anthropic API key
  ····<last 4>」.
- 费用 is one plain sentence built from the two billing accounts, for example
  「模型费用由你的 Claude 订阅承担，云电脑费用由你的 E2B 账号承担，Mikka 不收费。」
- Raw IDs (run, workspace, accounts, resource references and revisions) only go
  into 「复制诊断信息」, which copies them as text. They are not shown.
- Needs names the evidence does not carry yet: workspace name, people's names
  and images, device name, subscription account label, key suffix. Read them
  for the IDs the snapshot already holds, owner-only as today.

## Reviews (2026-11-06)

- `interface-design:design-review`: three blockers fixed — the PR title was shown
  three times (the card row is gone); the merged state did not change the
  report icon and thread status; evidence thumbnails were empty grey boxes. One
  should-fix fixed: two status dots in the hover card. Remaining notes: the
  copy button is drawn at 14px and is an `icon-xs` button (24px) in code.
- `unslop`: light. No gradients, glows, emoji or filler copy. Fixed: five check
  pills became one status plus grey text; the play glyph on the video duration.
