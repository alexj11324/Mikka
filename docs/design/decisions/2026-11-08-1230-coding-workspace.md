# Review a coding task's changes on one review page, opened from a one-line summary

- Date: 2026-11-08
- Status: draft. The coordinator reviews it before it is accepted.
- Source:
  - Alex approved the research and sketches (「可以，先做调研和草图」).
  - Alex on sending comments: 「评论单独做一个发给 agent 的按钮」.
  - Alex on attempts: 「不管第一次还是第二次尝试，改的都是同一个工作区，应该只有最后一次」.
  - The coordinator simplified the layout after [Linear Diffs](https://linear.app/docs/diffs) and settled the remaining points from [the research](../../research/2026-11-08-coding-workspace-layout.md).
- Rule: R-51 (exception below); R-37 and R-40 still hold.
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
| R0b 任务面板 | The task detail keeps its current shape and gains the same line with 「审阅」. Attempts appear only in 活动: 第 1 次尝试 · 失败 · 换 Codex 再试 → 第 2 次尝试 · 完成 · 开了 PR #1471. | `1120:432` | `1120:664` |
| R1 审阅页 | One full page, described below. | `1120:869` | `1120:1231` |
| R1b 检查展开 | The check summary expands in place: the failing check with a log excerpt, 查看完整日志 and 附到评论; the passing checks in one row. | `1120:1542` | `1120:1895` |
| R2 iPhone 审阅 | Opened in one tap from the chat card's summary line. It shows the check summary row (tap to expand), the PR, 要求修改 / 批准合并, the changed files, and the floating 「N 条评论 · 发给 Agent」 bar. | `1121:54` | `1121:169` |
| R3 iPhone 文件 diff | A file's diff with inline comments and the floating bar. | `1121:274` | `1121:359` |

## The review page (R1)

- **Left, narrow:** the task's conversation ([2026-11-07-2300](2026-11-07-2300-one-conversation-per-task.md)). It shows the agent's replies, the sent 「你：N 条评论」 message, and the conversation's own 回复 composer.
- **Middle:** the changed files only, grouped by folder, each with `+N −M`. Mark as viewed.
- **Right:** the diff, unified or split, with inline comments. A small, collapsed 「按提交筛选」 sits in the diff header, as in Linear, and not in the main toolbar.
- **Top bar:**
  - On the left: the title and the PR number.
  - On the right, in this order: the check summary 「⚠ 1 项检查失败 · 5 项通过」, which expands in place (R1b), then 「要求修改」 and 「批准合并」, then ✕ (Esc).
  - 批准合并 is a dark, neutral button with the PR icon. It is never the accent blue that 发给 Agent uses.
- **Bottom:** the batch bar 「2 条评论 · ios-unit 失败 · 发给 Agent」, in the accent colour. It is visually separate from 批准合并: 发给 Agent sends comments to the agent, and 批准合并 merges the PR.
- **Opening and closing:** it opens from any 审阅 entry or ⌘⇧B, and Esc (when focus is not in a text field) or ✕ closes it. The switch is instant (R-37).

## Decisions

1. **No diff on the task.** The chat card, the task panel and the 等待你 list each show one summary line with 「审阅」. Non-coding tasks are unchanged.
2. **One review page.** It opens in one click from any entry. The old route through the task panel's tabs is dropped.
3. **The default is the whole PR's final diff** (base…head). There is no attempt switch: every attempt edits the same workspace (Alex). 第 N 次尝试 appears only in the task's 活动 timeline and as dividers in the conversation, never as a diff scope.
4. **Comments have their own 「发给 Agent」 button** (Alex).
   - Line comments collect in the batch bar 「N 条评论 · 失败检查」.
   - A failed check is added with 附到评论 from the expanded check summary. It is never sent on its own.
   - Sending posts the batch as one message in the task's conversation, 「你：N 条评论」, with `file:line` quotes. The history stays visible and there is no hidden channel.
   - The agent's fix comes back in the same conversation, and the review page refreshes.
5. **R-51 exception.** Only the review page may carry actions: comment, 发给 Agent, 附到评论, 要求修改 and 批准合并. The task panel stays read-only apart from its 「审阅」 entry.
6. **After a PR exists**, the diff and checks stay in Mikka. 「在 GitHub 打开」 is a secondary link.
7. **iPhone parity** with R2 and R3: the summary line opens the review screen in one tap, with line comments, 发给 Agent, the checks and the PR actions. There is no terminal and no editor.
8. **No grey slabs.** Properties are label/value rows on the panel background.

## Scope

**P0**
- The summary line and 「审阅」 on the chat task card, the task panel and the 等待你 list; ⌘⇧B; ⌘K 「审阅 #N」.
- The review page:
  - changed files and the diff, unified and split;
  - inline comments and 「发给 Agent」;
  - the check summary with in-place expansion and 附到评论;
  - 要求修改 / 批准合并;
  - mark as viewed.
- Changes are always available for every coding task. While the machine runs, they come from the machine's working tree. Afterwards they fall back to the checkpoint diff, then the PR diff. A large change loads per file instead of showing a single 「太大」 notice.
- iPhone parity (R2, R3).

**P1**
- 按提交筛选 in the diff header.
- Undo a file or hunk.

**P2 (optional)**
- A repository file tree and read-only source.
- A terminal (task owner only; teammates read-only; no secret files, [2026-11-08-0240](2026-11-08-0240-credential-exposure-boundary.md)).
- A dev-server preview.
- Restore to an earlier turn.
