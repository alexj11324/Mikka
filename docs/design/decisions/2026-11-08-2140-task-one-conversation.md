# A task is one conversation; a divider only where the Agent changed

- Date: 2026-11-08
- Source: Alex, relayed by the coordinator: a factory task's conversation said 「第 2 次尝试结束 · 再试」 where the next run was the factory's independent review, and the task page's 活动 listed 「第 1/2/3 次尝试 · 等你回复 · Codex」 for runs that were one conversation.
- Rule: `apps/mobile/features/tasks/model/task-conversation.ts` (`boundary`, `activityEntries`)
- Superseded by: [2026-11-09-0045](2026-11-09-0045-no-attempt-word.md) on the divider's words and, as amended there the same day, on 「换」: a change of Agent is labelled with the next Agent's mark and name, as Warp does
- Amends: [2026-11-07-2045](2026-11-07-2045-tasks-only-threads-inside.md) and [2026-11-07-2230](2026-11-07-2230-one-icon-per-task-state.md) on how attempts are labelled

- Runs with the same Agent (follow-ups, waiting for a reply, the factory's review, verify and fix) are one continuous conversation: no 「第 N 次尝试」 divider and no 「· 再试」 between them.
- The factory follows [2026-11-04-2200](2026-11-04-2200-factory-flow-like-warp.md): verification belongs to 实现, so it has no marker; 审阅 runs once and is one result card, 「审阅 · 通过 / 需要修改 / 需要你判断」, that opens to the reviewer's transcript instead of showing its full text; going back to fix is a small marker 「修复」. These come from the run's `stage` and the task's `flow` (stage, 需要你, 审阅's verdict) when the server sends them; without them, no marker, no verdict.
- The top of the task's conversation shows the task's one stage and what it needs from you, 「交给你 · 需要你：PR 待审」, from the same `flow`.
- Only a switch to another Agent (Claude Code ↔ Codex ↔ Cursor) divides the conversation: 「换 Claude Code 继续」, or 「第 1 次尝试失败 · 换 Claude Code 再试」 when the run before failed. 「第 N 次」 counts Agent switches only.
- 活动 on the task page shows one row per Agent's stretch: 「Codex · 等你回复 · 11月5日」 with the latest run's state and date, and 「换 Claude Code」 where the task switched. A row opens the one conversation at its first run.
