# A coding task opens a workspace beside its one conversation

- Date: 2026-11-08
- Status: draft. The coordinator reviews it before it is accepted.
- Source:
  - Alex approved the research and sketches (「可以，先做调研和草图」).
  - Alex on sending comments: 「评论单独做一个发给 agent 的按钮」.
  - The coordinator settled the remaining points from the references in [the research](../../research/2026-11-08-coding-workspace-layout.md) (Conductor, Claude Code Desktop, Codex, Cursor, Linear Diffs, GitHub Mobile).
- Rule: R-51 (exception below); R-37 and R-40 still hold.
- Replaces: the 改动 tab appearing only when the run saved a checkpoint, and a thread's files only linking out to GitHub once a PR exists (`components/workspace/thread-changes.tsx`, `lib/thread-changes.ts`).

The layout does not change for ordinary work: icon rail, bot list, chat, and the right task column. A task that touches a repository gets a workspace inside the panel that already shows its conversation. There is no new rail item and no new page.

## Layout

The frames are a structure sketch, not a visual spec. They are on Figma `zPe5LKycb2XuT1ivCLRw07`, page `1110:2` 「代码工作区 草图 2026-11-08」, in light and dark. Build with the hosted UI's real components (R-90), not by copying the sketch's spacing.

| Frame | What it fixes | Light | Dark |
|---|---|---|---|
| D1 平常 | Normal layout. The task detail in the right column shows a 「改动」 row (files, `+N −M`, failed checks) that opens the workspace. | `1110:4` | `1110:195` |
| D2 代码任务 | The task's panel has the tabs 对话 · 改动 · 文件 · 验收 · 预览, with the branch on the right. 改动's header holds the scope switch and one status line, 「⚠ 1 项检查失败 · PR #1471 待审阅 ›」, which opens 验收. The ⤢ tooltip reads 「审阅模式 ⌘⇧B」. | `1110:386` | `1110:652` |
| D3 审阅模式 | The bot list and bot chat hide. A narrow left strip holds the task's conversation and its composer, including an earlier sent batch, 「你：2 条评论」 with `file:line` quotes. The workspace fills the rest: scope switch, status line, unified or side-by-side, viewed count, file list, diff, line comments, and the batch bar 「N 条评论 · 失败检查 · 发给 Agent」. | `1111:2` | `1111:336` |
| D4 文件与终端 | 文件 tab: the repository tree with ⌘P quick open, read-only source, and the terminal drawer (phase 2). | `1111:670` | `1111:978` |
| D4b 队友的终端 | A teammate sees the terminal read-only, with 「只有任务负责人可以操作」, and cannot reply in the conversation. | `1117:613` | `1117:923` |
| D5 验收 | The PR (status, 要求修改 / 批准合并), CI checks with a log excerpt, 附到评论 on a failed check, and the acceptance report. | `1117:2` | `1117:370` |
| M1 iPhone 改动 | One line, 「1 项检查失败 · PR #1471 待审阅」, that opens 验收; the changed files; the floating batch bar. | `1112:2` | `1112:109` |
| M2 iPhone diff | A file's diff with pending line comments and the batch bar. | `1112:216` | `1112:301` |
| M3 iPhone 评论 | A sheet listing the batch, with a switch to attach the failed check, and 「发给 Agent」. | `1112:386` | `1112:508` |
| M4 iPhone 验收 | The PR with its two actions, the checks, 附到评论 on a failed check, and the acceptance report. | `1117:1216` | `1117:1378` |

## Decisions

1. **The workspace is the existing thread panel plus tabs**, in this order: 对话 · 改动 · 文件 · 验收 · 预览. The terminal is a drawer, not a tab. 改动 holds only the diff, line comments, the scope switch and the batch bar; its header has a single status line that links to 验收. **Checks and the PR live in 验收**, the existing acceptance tab (`factory-acceptance-pane.tsx`, `artifact-review.tsx`): the PR status with 要求修改 / 批准合并, the CI checks with logs, 附到评论 for a failed check, and the acceptance report. Three of the four references give checks and the PR their own place (Conductor's Checks tab, Cursor's PR tab, Codex's Code Review > Checks). A task has one conversation ([2026-11-07-2300](2026-11-07-2300-one-conversation-per-task.md)), and the workspace sits beside it.
2. **Review mode.** It opens with the ⤢ button, whose tooltip shows ⌘⇧B, as in Codex. The exit button's tooltip also shows ⌘⇧B; Esc is a secondary hint. Esc leaves it only when focus is not in a text field. Switching is instant (R-37). On narrow windows, review mode is full screen and the conversation becomes a tab.
3. **Comments have their own 「发给 Agent」 button** (Alex). Line comments collect in a batch bar that reads 「N 条评论 · 失败检查」, with 「发给 Agent」. A failed check is added from its row in 验收 with 附到评论, which puts it in the 改动 batch; it is never sent on its own. The task composer carries no comment attachments. Sending posts the batch as one message in the task's conversation, 「你：N 条评论」, with `file:line` quotes, so the history stays visible and there is no hidden channel. The agent's fix comes back in the same conversation, and 改动 refreshes. The phone uses the same button and the same message.
4. **R-51 exception.** Only the workspace tabs (改动 / 文件 / 验收 / 预览) may carry actions: comment, 发给 Agent, attach a failed check, the PR's 要求修改 / 批准合并, and run actions. The rest of the right panel stays read-only.
5. **Scope.** 改动 shows all of the task's changes by default, with a switch to 全部 / 第 N 次尝试 / 某个提交.
6. **After a PR exists**, the diff and checks stay in the app. 「在 GitHub 打开」 is a secondary link.
7. **Terminal (phase 2).** It is a drawer at the bottom of the workspace (⌘J, Ctrl+`). Only the task's owner can type in it; teammates read only and see 「只有任务负责人可以操作」 ([2026-11-01-2300](2026-11-01-2300-thread-visibility-follows-warp.md); frame D4b). It never shows secret files ([2026-11-08-0240](2026-11-08-0240-credential-exposure-boundary.md)).
8. **iPhone.** The phone gets 改动, line comments, checks, and 发给 Agent. It has no terminal and no editor. Line comments on the phone follow GitHub Mobile's line comments on PR files.
9. **No grey slabs.** Properties are label/value rows on the panel background. File headers and check rows have no fill.

## Scope

**P0**
- Every coding thread shows 改动, not only once a checkpoint exists. While the machine runs, it reads the machine's working tree. Afterwards it falls back to the checkpoint diff, then the PR diff. A large change loads per file instead of showing a single 「太大」 notice.
- The 文件 tab: the repository tree, ⌘P quick open, and read-only source.
- Line comments with 「发给 Agent」 on the web and on iPhone, sent as one message in the task conversation.
- 验收 holds the checks and the PR, with 附到评论 for a failed check. 改动 shows one status line that links to it.
- Review mode, the scope switch, and mark as viewed.

**P1**
- The terminal drawer.
- Run, test and build actions from the repository's configuration.
- The 预览 tab with port forwarding, which pops out into its own window on the desktop app.
- Undo a file or hunk.

**P2**
- Restore the code to an earlier turn.
- A Git branch and commit panel.
- @-file references in the composer.
- Editing source in place.
