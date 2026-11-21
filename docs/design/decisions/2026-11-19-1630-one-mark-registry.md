# One registry for every state mark, and a thread drawn with the same marks as a status

- Date: 2026-11-19
- Source: Alex, 2026-11-19: 「气泡你可以换吗？…我总感觉现在 issue 跟线程之类的有点不好看」, and authorising Capy's approach for it; the colour order was then read live from Capy 0.9.2 (`text-success` for review, the violet `text-complete` for done, which is Linear's order too).
- Rule: R-52; `docs/design/components.md` (task status icon and Agent mark, thread state icon)
- Replaces: `docs/design/chat-tool-calls.md` §2.5 (Alex, 2026-11-04: 「issue 和 chat 的状态要有区分度」), the clause 「线程一律用对话气泡，状态用气泡右上角的色点表示…线程的任何地方都不再用圆圈」 — a thread now draws its group with the same marks a task's status uses.
- Also replaces the colour clause of [2026-11-13-1405](2026-11-13-1405-one-task-status.md) as that record states it: 评审中 is green and 已完成 the violet `--info`, not the other way round. The rest of 1405 stands.

## One vocabulary

A state mark is a shape and a tone. There is one closed shape vocabulary and one closed tone vocabulary, and one renderer:

| Where | What |
| --- | --- |
| `lib/state-mark.ts` | `MARK_SHAPE_NAMES`, `MARK_TONE_NAMES`, `markToneClass`, `stateMarkTone`, the six domains' tables and their resolvers. Plain data and functions; no React. |
| `components/workspace/state-mark.tsx` | `Mark({shape, tone, size})`, `StateMark`, and one icon component per status and per priority. |

- Shapes: `dashed empty half progress check x slash hand question alert urgent bars-1 bars-2 bars-3`.
- Tones: `gray yellow green blue purple red`, each one semantic text token (`markToneClass`). `blue` is the label palette's blue; `purple` is `--info`, which this product draws violet.
- Geometry is one box: `viewBox="0 0 14 14"`, `currentColor`, stroke 1.25, circles r=5 around (7, 7); sizes from one ladder, `sm` 14 / `md` 16 / `lg` 18.
- The renderer takes no `className`. A mark's colour is its tone and its size is its `size`, so no call site can paint a mark and the ui lint can still read every class.

## One colour per mark

`stateMarkTone(mark)` is the only way to get a colour out of a mark: it maps the tone to the badge-or-dot tint set, and the chip, the dot beside it and the badge all read it. Before this, a 进行中 chip was amber while the dot on the same row was green, because the dot had a table of its own. That shape of defect is no longer writable.

## The six domains

| Domain | Table | Resolver | Rows |
| --- | --- | --- | --- |
| status | `ISSUE_STATUS_MARKS` | `statusMarkOf` | 待整理 dashed·gray, 待办 empty·gray, 进行中 half·yellow, 评审中 progress·green, 已完成 check·purple, 已取消 x·gray, 重复 slash·gray |
| priority | `ISSUE_PRIORITY_MARKS` | `priorityMarkOf` | 紧急 urgent·yellow, 高 bars-3·gray, 中 bars-2·gray, 低 bars-1·gray |
| thread | `THREAD_MARKS` | `threadMarkOf` | 进行中 half·yellow, 等待你 hand·blue, 受阻 x·red, 空闲 empty·gray, 已解决 check·green |
| run | `RUN_MARKS` | `runMarkOf` | working progress·yellow (the one mark that turns), waiting hand·blue, error alert·red |
| pullRequest | `PULL_REQUEST_MARKS` | `pullRequestMarkOf` | open progress·green, draft empty·gray, merged check·purple, closed x·red |
| needsYou | `NEEDS_YOU_MARK` | — | hand·blue. Not a status (R-52): what needs the person stays in 收件箱. |

A surface that only has a status key calls the resolver and draws what it returns, never the registry's internals. `ISSUE_STATUSES`, `ISSUE_PRIORITIES`, `PROJECT_STATUSES`, `PROJECT_PRIORITIES`, `STATUS_ICONS` and `PRIORITY_ICONS` all take their icon and tone from these tables, so a status or a priority is drawn once and coloured once.

## A thread is a mark now

The speech bubble and its corner dot are gone. A thread draws its group's mark — the same shapes and tones a task's status uses — and its badge takes the group's tint from `stateMarkTone`. 等待你 is the hand everywhere it is drawn: the thread mark, the Agent mark, `StatusDot`, a computer's 「等你审批」 pill, and the exported `NEEDS_YOU_MARK`.

This does not revive the older defect 1405 fixed: a task's chip still carries exactly one glyph, and two status-like glyphs are still never side by side. What changed is that a thread no longer needs a drawing language of its own to stay distinct — the vocabulary carries the state, and the row's words carry what the thing is.

## A mark never blocks

A mark is display only. It is read from data a surface already has, it has no loading state of its own, and it must never hold up the surface around it — no dialog, list or action waits on a mark. The 2026-11-19 新建任务 fix, where a failed project read no longer blocks the dialog, is the rule this keeps.
