# Review a coding task's changes on one review page, opened from a one-line summary

- Date: 2026-11-08
- Status: accepted. Alex approved the R0–R3 design: 「可以」 (2026-11-08, relayed by the coordinator). On where the code tools go: 「只要求你把这些东西放进省略号里边…不是放在省略号的外边」, so they live in the ⋯ menu, not as visible buttons. The globe stays where it is: 「浏览器你可以放到最右上角呀」.
- Source:
  - Alex approved the research and sketches (「可以，先做调研和草图」).
  - Alex on sending comments: 「评论单独做一个发给 agent 的按钮」.
  - Alex on attempts: 「不管第一次还是第二次尝试，改的都是同一个工作区，应该只有最后一次」.
  - The coordinator simplified the layout after [Linear Diffs](https://linear.app/docs/diffs) and settled the remaining points from [the research](../../research/2026-11-08-coding-workspace-layout.md).
- Rule: R-51 (exception added), R-91 (new: top rows carry the important things); R-35, R-37, R-40 and R-57 still hold (the globe stays at the window bar's top right).
- Replaces:
  - The 改动 tab appearing only when the run saved a checkpoint, and files only linking out to GitHub once a PR exists (`components/workspace/thread-changes.tsx`, `lib/thread-changes.ts`).
  - The earlier sketches D0–D5 and M0–M4 on the same Figma page, now marked 已取代.

Ordinary work keeps its layout: icon rail, bot list, chat, and the right task column. A coding task does not embed a diff anywhere. Wherever the task appears, it shows one summary line and a 「审阅」 button. The button opens one full review page.

## Precedent

[Linear Diffs](https://linear.app/docs/diffs):
- Reviews are their own place: a Reviews inbox in the sidebar, not a diff embedded in the issue.
- A review shows the whole pull request, unified or split (⌘B).
- There is no repository tree.
- Approving, requesting changes and merging happen on the review.

On the phone, [GitHub Mobile](https://github.blog/changelog/2026-02-03-github-mobile-comment-on-unchanged-lines-in-pull-request-files/) supports line comments on PR files.

## Layout

The frames are a structure sketch, not a visual spec. They are on Figma `zPe5LKycb2XuT1ivCLRw07`, page `1110:2` 「代码工作区 草图 2026-11-08」, in light and dark. Build with the hosted UI's real components (R-90), not by copying the sketch's spacing.

| Frame | What it fixes | Light | Dark |
|---|---|---|---|
| R0 入口 | The chat's task card and the window bar's 等待你 list show one line, 「PR #1471 · 3 个文件 +42 −7 · ⚠ 1 项检查失败」, with 「审阅」. One click opens R1. The list's footer shows ⌘⇧B and ⌘K 「审阅 #1471」. | `1120:2` | `1120:227` |
| R0b 任务面板 | The task detail keeps its current shape. Its header row is `#1471 修复 iOS 登录回调 · ⋯ · ⤢ · ✕`. The ⋯ menu, drawn open, lists the code tools first: 改动 (+42 −7, ⌘⇧B) opens R1, 文件 opens R4, 终端 (⌘J) opens R5 and 预览 opens the dev preview. After a divider come the branch name, 复制链接 and 权限. The first row under the title, above 状态 / Bot / Agent, is 「PR #1471 · 3 个文件 +42 −7 · ⚠ 1 项检查失败 ›」, and the whole line opens R1. A non-coding task's ⋯ has no code tools. 活动 has one row per Agent stretch ([2026-11-09-0045](2026-11-09-0045-no-attempt-word.md)): Claude Code · 失败 → 换 Codex · 完成 · 开了 PR #1471. | `1120:432` | `1120:664` |
| R1 审阅页 | One full page, described below. | `1120:869` | `1120:1231` |
| R1b 检查展开 | The check summary expands in place: the failing check with a log excerpt, 查看完整日志 and 附到评论; the passing checks in one row. | `1120:1542` | `1120:1895` |
| R4 文件 | The top bar's ⋯ is open with 文件 checked (Conductor's All files): the repository tree, with changed files marked, and read-only source on the right. | `1125:22` | `1125:481` |
| R5 终端 | The top bar's ⋯ is open with 终端 checked (or ⌘J): a bottom drawer on the review page. Teammates see the terminal read-only. | `1125:786` | `1125:1163` |
| R2 iPhone 审阅 | Opened in one tap from the chat card's summary line. Under one centred title, the first row is the check summary (tap to expand) with 批准合并, then the changed files, and the floating bar: 「N 条评论 · 失败检查」 above 「写修改意见…」 and 发给 Agent. The bar is always there, also with no comments. | `1121:54` | `1121:169` |
| R2b iPhone 修改意见 | Tap 「写修改意见…」: a sheet titled 「修改意见」 with ✕, a text area and a full-width 「发给 Agent」. A general note can be sent with no line comments; with comments, they go in the same message. | `1134:10` | `1134:119` |
| R3 iPhone 文件 diff | A file's diff with inline comments and the floating bar. | `1121:274` | `1121:359` |
| R3b iPhone 加评论 | Tap a line: a sheet titled 「第 22 行」 with the line, an input and 「加入评论」. The comment joins the floating batch. | `1131:224` | `1131:328` |
| R2a iPhone 任务详情 | The iOS task detail has the summary row 「PR #1471 · +42 −7 · ⚠ 1 项失败 ›」 under the title; one tap opens R2. | `1131:2` | `1131:152` |
| R6 运行中、还没开 PR | While the agent runs and before a PR exists, the top bar shows 「运行中 · 还没开 PR」 instead of 批准合并, and the diff is marked 实时 and updates live. The R0 summary line reads 「3 个文件 +42 −7 · 运行中」, without a PR number. | `1129:24` | `1129:336` |
| R7 合并确认 | 批准合并 with a failing check asks 「还有 1 项检查失败，确定合并？」 with 取消 / 仍然合并. | `1129:622` | `1129:948` |
| R8 已合并 | After the merge: 「已合并」 in the top bar, the task is 已完成, the batch bar is gone and the comments show as sent. | `1129:1274` | `1129:1589` |
| R9 完整日志 | 查看完整日志 opens the bottom drawer on its 运行日志 tab, the same drawer as the terminal. | `1130:2` | `1130:403` |
| R10a 预览 · 未启动 | ⋯ › 预览 with no dev server running: a small panel 「没有运行中的开发服务器」 with 「启动预览」. | `1130:738` | `1130:1056` |
| R10b 预览 · 已打开 | With a dev server running, the preview opens in the app's browser column (the globe's browser), pointed at this task's machine. | `1130:1374` | `1130:1704` |
| R11 队友 | Without permission, 批准合并, 发给 Agent and 终端 are disabled and say why: 「只有任务负责人可以合并」, 「只有任务负责人可以发给 Agent」, 「只有任务负责人可以用终端」. | `1130:2034` | `1130:2375` |
| R12 空和兜底 | Three panels: no changes; a change too big to load at once (per-file 加载); the machine reclaimed, 「机器已回收，显示的是最后一次检查点 / PR 的改动」 with the source and time. | `1130:2689` | `1130:3038` |

## The review page (R1)

- **Left, narrow:** the task's conversation ([2026-11-07-2300](2026-11-07-2300-one-conversation-per-task.md)). It shows the agent's replies, the sent 「你：N 条评论」 message, and the conversation's own 回复 composer.
- **Middle:** the changed files only, grouped by folder, each with `+N −M`. Mark as viewed.
- **Right:** the diff, unified or split, with inline comments. A small, collapsed 「按提交筛选」 sits in the diff header, as in Linear, and not in the main toolbar.
- **Top bar:**
  - On the left: the task title only.
  - On the right, in this order: the check summary 「⚠ 1 项检查失败 · 5 项通过」, which expands in place (R1b), then 「批准合并」, then ⋯ and ✕. There is no separate 要求修改: 发给 Agent is the one submit, as GitHub and Linear have one submit-review.
  - The ⋯ menu lists the code tools first, in the task panel's order with the same shortcuts: 改动, 文件, 终端, 预览. The current view is checked. They switch the page between changes, all files, the terminal drawer and the preview.
  - The branch name, the viewed count (已看 1/3), copy link, permissions and shortcut hints go into ⋯ or tooltips. The bar shows no Esc text.
  - 批准合并 is a dark, neutral button with the PR icon. It is never the accent blue that 发给 Agent uses.
- **Bottom:** the batch bar 「2 条评论 · ios-unit 失败 · 写修改意见… · 发给 Agent」, always present, so a general note can be sent with no line comments. 发给 Agent is in the accent colour. It is visually separate from 批准合并: 发给 Agent sends comments to the agent, and 批准合并 merges the PR.
- **Opening and closing:** it opens from any 审阅 entry or ⌘⇧B, and Esc (when focus is not in a text field) or ✕ closes it. The switch is instant (R-37).

## Decisions

1. **No diff on the task.** The chat card and the 等待你 list each show one summary line with 「审阅」. The task panel shows the same summary line under the title, and the whole line opens the review page. The code tools 改动 · 文件 · 终端 · 预览 are in the task panel's ⋯ menu, not visible buttons (Alex: 「只要求你把这些东西放进省略号里边…不是放在省略号的外边」). Non-coding tasks are unchanged.
2. **One review page.** It opens in one click from any entry. The old route through the task panel's tabs is dropped.
3. **The default is the whole PR's final diff** (base…head). There is no attempt switch: every run edits the same workspace (Alex). Runs show only as the task's 活动 stretches and an Agent-switch divider in the conversation ([2026-11-09-0045](2026-11-09-0045-no-attempt-word.md)), never as a diff scope.
4. **Comments have their own 「发给 Agent」 button** (Alex).
   - Line comments collect in the batch bar 「N 条评论 · 失败检查」.
   - A failed check is added with 附到评论 from the expanded check summary. It is never sent on its own.
   - Sending posts the batch as one message in the task's conversation, 「你：N 条评论」, with `file:line` quotes. The history stays visible and there is no hidden channel.
   - 发给 Agent also marks the PR 「需要修改」 (synced to GitHub as request-changes) and starts the next attempt on the same branch.
   - Pending comments show 编辑 / 删除 on hover.
   - The agent's fix comes back in the same conversation, and the review page refreshes.
5. **R-51 exception.** Only the review page may carry actions: comment, 发给 Agent, 附到评论 and 批准合并. The task panel stays read-only apart from its summary line and the code tools in its ⋯ menu, which only open the review page.
6. **After a PR exists**, the diff and checks stay in Mikka. 「在 GitHub 打开」 is a secondary link.
7. **iPhone parity** with R2 and R3: the summary line opens the review screen in one tap, with line comments, 发给 Agent, the checks and the PR actions. There is no terminal and no editor.
8. **No grey slabs.** Properties are label/value rows on the panel background.
9. **Top rows carry the important things** (R-91) (Alex: the top rows had room but held low-value items). On every surface the first row holds the task's state and its main action: PR, failed checks and 审阅 next to the task title; checks and 批准合并 on the review page and on iPhone. Branch names, counts and shortcut hints go into ⋯ or tooltips.

## 流程走查

Every state can be reached and left from the screen; none is a dead end.

| State | How you get there | How you leave |
|---|---|---|
| Chat card / 等待你 summary line (R0) | The task appears in a bot chat or in ✋ 等待你 | 「审阅」 → R1; the card → the task panel (R0b) |
| Task panel (R0b) | The chat card, the board, the window bar | Summary line or ⋯ › 改动 → R1; ⋯ › 文件 → R4; ⋯ › 终端 → R5; ⋯ › 预览 → R10a/R10b; ✕ closes |
| Review page (R1) | 审阅, the summary line, ⋯ › 改动, ⌘⇧B, ⌘K 「审阅 #N」 | ✕ or Esc → where you came from; 批准合并 → R7 or R8; 发给 Agent → stays, a new attempt starts (R6) |
| Running, no PR (R6) | A running coding task, from any entry | The PR opens → R1; ✕ |
| Checks expanded (R1b) | Click the check summary | Click it again; 查看完整日志 → R9; 附到评论 → the batch bar |
| All files (R4) | ⋯ › 文件 | ⋯ › 改动 |
| Terminal (R5) | ⋯ › 终端 or ⌘J | ⌘J or the drawer's ⌄ |
| Full log (R9) | 查看完整日志 | The drawer's 终端 tab or ⌄ |
| Preview (R10a / R10b) | ⋯ › 预览 | 启动预览 → R10b; ✕ on the browser column |
| Merge confirm (R7) | 批准合并 with a failing check | 取消 → R1; 仍然合并 → R8 |
| Merged (R8) | A merge | ✕; the task is 已完成 in lists |
| Teammate (R11) | A teammate opens any entry | ✕; disabled actions say why |
| Fallbacks (R12) | No changes, a change too big, or the machine reclaimed | Per-file 加载; the source line says which checkpoint or PR is shown |
| iPhone task (R2a) → review (R2) → diff (R3) → add comment (R3b) | The task, then its summary row, then a file, then a line | Back at each step; 加入评论 → R3; 发给 Agent → the task conversation |
| iPhone note sheet (R2b) | 「写修改意见…」 in R2's floating bar | ✕ or swipe down → R2; 发给 Agent → the task conversation (「你：修改意见」, plus any comments) |

## Scope

Scope and priorities stay as [#1720](https://github.com/alexj11324/Mikka/issues/1720) sets them: everything on the gap list is built, and nothing is dropped. This decision sets the layout and the order of the first deliverable, not the scope. #1720's items land on the review page:

| #1720 item | Where it lives |
|---|---|
| Changes, inline comments, feedback to the agent, PR and checks (#1722, #1732, #1502, #1503) | The summary line and 「审阅」 (R0, R0b); the review page (R1, R1b) |
| Repository file tree, source, ⌘P (#1721, #1731) | ⋯ › 文件 on the task panel and the review page (R4) |
| Terminal, run actions (#1723, #1727, #1733) | ⋯ › 终端 or ⌘J: a bottom drawer on the review page (R5) |
| Dev preview, ports (#1724, #1733) | ⋯ › 预览. It opens in the app's browser column (R-57) or a pop-out window |
| Git history, undo, commit filter (#1726) | 按提交筛选 in the diff header; file and hunk actions on the review page |
| iPhone | R2, R2b, R3 |

The rest of #1720 (#1728, #1729, #1730, #1734, #1735) keeps its priorities. When any of it gets a surface, it goes on the review page, never as a new tab on the task panel.

## Implementation evidence boundary (2026-11-08)

This is the accepted specification. Source at `420b1ebe1` contains web review
DTOs and adapters in `lib/code-review/`, hooks in `hooks/code-review/` and
native screens in `apps/mobile/features/review/`. The public `review-page`
and `review-summary` slots render nothing, with `REVIEW_ENABLED=false`; a
selected UI layer supplies those surfaces. `REVIEW_ENDPOINTS` in
`lib/code-review/client.ts` explicitly records the API routes as proposed
pending #1722. These source additions do not establish matching backend,
GitHub-side effects or native runtime acceptance. Record that evidence on
the owning implementation issues at their tested revision.
