# One icon set for task statuses and run states

- Date: 2026-11-18
- Source: Alex, 2026-11-18, on the official build: 「task 的状态图标不统一」. He pointed to LobeHub's source as the model, and left the open choices to the implementer: 「拉不准的地方，请你按照你的直觉决定。去改吧」.
- Rule: R-52; `components.md` (Task status icon and Agent mark); `glossary.md` (Task status, Agent mark, Run result)
- Replaces, in part: [2026-11-13-1405](2026-11-13-1405-one-task-status.md), the table of status icons (Orca's shapes for 进行中, 评审中, 已完成) and 「受阻 and 已隐藏 … keep the block's glyphs」 for 受阻.
- Keeps: [2026-11-07-2230](2026-11-07-2230-one-icon-per-task-state.md)'s one icon per state, the hand only for waiting on the person, failed as a triangle, no dots or badges; [2026-11-07-2300](2026-11-07-2300-one-conversation-per-task.md)'s octagon for 受阻 and no hand on an attempt; [2026-11-08-0130](2026-11-08-0130-task-state-icon-colours.md)'s colours; [2026-11-04-2220](2026-11-04-2220-task-circle-thread-bubble.md)'s bubble for a thread.

## What was wrong

One state was drawn from four sources: the status field (lucide plus three shapes ported from Orca), the Agent mark (lucide), the hosted run results (Remix icons and hand-drawn rings) and the Kanban template's own glyphs in the task page's status menu and the board's 受阻 column. 进行中 was a different shape in the status row and in its own menu; a running Agent was a spinner on one card and a turning ring on another; 受阻 was the template's triangle, which is a failed run's shape.

## Research

LobeHub (`lobehub/lobehub`, `src/components/ExecutionStatus.ts`) keeps one table, `VISUALS`, read by sidebar rows, group headers, kanban columns and tables: 「One semantic → one visual, so the same state never renders with different icons across surfaces」. Every glyph is lucide: backlog `CircleDashed`, idle `Circle`, running `CircleDot` (a live row swaps in a turning ring of the same family), scheduled `Clock`, waiting for a person `Hand`, completed `CircleCheck`, canceled `CircleSlash`, failed `CircleX` (a topic's failure `TriangleAlert`).

## The rule

All glyphs are lucide, in two tables in `components/workspace/`:

| State | Icon | Colour |
| --- | --- | --- |
| 待整理 | `CircleDashed` | grey |
| 待办 | `Circle` | grey |
| 进行中 | `CircleDot` | warning |
| 评审中 | `Eye` | info |
| 已完成 | `CircleCheck` | success |
| 已取消 | `CircleX` | grey |
| 重复 | `CircleSlash2` | grey |
| Agent working / run running | `CircleDot` whose ring turns as a broken arc (`RunningIcon`); still under reduced motion | warning |
| Agent waiting for you | `Hand` | info |
| Agent error / run failed | `TriangleAlert` | error |
| 受阻 | `OctagonAlert` | warning |
| queued | `Clock` | warning |
| a run that ended waiting | `CirclePause` | info |
| a run with no task, never run | `CircleDashed` | grey |

- The statuses are `ISSUE_STATUSES` (`issue-properties.ts`), drawn by `TaskStatusIcon`. Run states are `EXECUTION_VISUALS` (`task-state-icon.tsx`), drawn by `ExecutionIcon`; the Agent mark, the hosted run results (`TaskStateIcon` without a task, `AttemptIcon`) and the board's 受阻 read it. No surface draws its own.
- Where we differ from LobeHub, and why: 评审中 is not the hand, because the hand means only 等你处理 (2230); 已取消 keeps `CircleX` and failure the triangle, because ✕ already meant 已取消 on our board (2230); 重复 has no LobeHub counterpart and keeps `CircleSlash2`.
- **Status-icon exception, extended** ([2026-11-09-0050](2026-11-09-0050-paid-blocks-as-shipped.md), 1405): the glyph-only swap now also covers the task page's status menu and property lines (they were the Kanban template's `ColumnMark`), the board's 受阻 column head and a card's 受阻 line, and the hosted thread's task card for a run with no task. As before, only the glyph changes; the block's box, spacing and colour tokens stay.
- The Orca shapes and their notice are removed (`NOTICE`).

- **The iOS app uses the same glyphs** (`apps/mobile/features/tasks/components/task-icons.tsx`, lucide-react-native): 评审中 is `Eye` (it was `CircleGauge`), and a running task or attempt is the turning `CircleDot` (a Reanimated CSS animation; `CircleDot` itself under Reduce Motion). Its list keeps its own groups and run states (2026-11-13-1405 left the app's model unchanged); only the glyphs follow this table, with the app's system colours (2026-11-08-0130).

Not changed: a thread stays a speech bubble with a state dot (`ThreadStatusIcon`). The paid Kanban's and Thread's demo-only parts that Mikka never shows (its own create window and card detail, the Thread's away summary) keep their template glyphs.
