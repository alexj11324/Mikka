# Where a thread runs, and reviewing its PR

- **Status:** in review (2026-11-06), waiting for Alex
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

- **Mark.** After the title: the device type icon (lucide `Cloud`, `Laptop`,
  `Server`, R-74) with the StatusDot on its top right (R-24), then the short
  name in 12px secondary text. Hover shows the subtle background and opens the
  card. The desktop app is the same web view.
- **Hover card.** `HoverCard` (`components/ui/hover-card.tsx`, unused so far),
  288 wide. Title row: icon, name, status as dot + word (R-87).
  - Cloud: ID (full E2B sandbox ID, mono, copy button), 模板 (`claude` / `codex`
    / `desktop`), 创建, and 停止 once ended. Action 「打开电脑」, or 「看桌面」 for
    the `desktop` template. Status 运行中 / 休眠 / 已停止 (from `thread_machines.state`).
  - Computer and server: 系统 (`platform` · `arch`), 主机 for SSH servers,
    上次在线 when offline. No action.
- **Cloud display name.** 「云电脑 <first 6 characters of the sandbox ID>」,
  for example 「云电脑 i8k2m3」. It is derived when the thread is read; the
  `devices` row keeps its locked name 「Thread computer」, so no column is added.
- **iOS.** The nav subtitle becomes `<Agent> · <SF Symbol> <name>` (`cloud`,
  `laptopcomputer`, `server.rack`). A tap opens a SwiftUI popover kept as a
  popover on iPhone, with the same rows plus 「复制 ID」 and 「打开电脑」.
- **Thread list rows: no mark.** R-53 keeps a row to two lines, and the
  全部线程 rows already carry the Agent mark and time (R-50). Where a thread runs
  matters when it is open, not while scanning; the one case that matters in a
  list (a run waiting for an offline computer) already shows `WaitingChip` with
  the device.

### Data

The thread read (`getIssueThread`; mobile `mobileThread`) gains one small
`machine` object for the latest run: `kind` (cloud / computer / server), `name`,
`platform`, `arch`, `online`, `lastSeenAt`, and for cloud `sandboxId`,
`template` (`thread_machines.snapshotId`), `state`, `createdAt`, `endedAt`.
It comes from `agent_runs.deviceId` → `devices` and `thread_machines` by run,
read in the same query that already loads the thread. No new column, no
polling; state changes arrive through the thread's existing live key.

## Part 2 · PR review (Artifact window)

Built on the accepted acceptance page (decision
[2026-11-04-2200](decisions/2026-11-04-2200-factory-flow-like-warp.md)): the
existing Artifact window, the report on the left, the thread on the right.
Glossary: the word 产物 is not used in the UI; the entry is named by the PR.

| Frame | Node |
| --- | --- |
| E1 Entry in the thread header, seven states, light / dark | `1058:1785` / `1058:1962` |
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

- **Entry.** One button at the right of the thread header, named by the PR and
  its state: none while running without a PR; 「准备 PR」 disabled with a
  spinner; 「PR #1288 待你审」 filled (the only filled button, R-89); 修复中 and
  合并中 with a spinner; 已合并 with the merged mark; 受阻 on the destructive tint.
  For a PR thread it takes the place of 「Artifact · N」. On the task, the
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

## Reviews (2026-11-06)

- `interface-design:design-review`: three blockers fixed — the PR title was shown
  three times (the card row is gone); the merged state did not change the
  report icon and thread status; evidence thumbnails were empty grey boxes. One
  should-fix fixed: two status dots in the hover card. Remaining notes: the
  copy button is drawn at 14px and is an `icon-xs` button (24px) in code.
- `unslop`: light. No gradients, glows, emoji or filler copy. Fixed: five check
  pills became one status plus grey text; the play glyph on the video duration.
