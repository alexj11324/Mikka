# A task is one conversation; 「尝试」 only where the Agent changed

- Date: 2026-11-08
- Source: Alex, relayed by the coordinator: a factory task's conversation said 「第 2 次尝试结束 · 再试」 where the next run was the factory's independent review, and the task page's 活动 listed 「第 1/2/3 次尝试 · 等你回复 · Codex」 for runs that were one conversation.
- Rule: `apps/mobile/features/tasks/model/task-conversation.ts` (`agentRuns`, `boundary`, `activityEntries`)
- Amends: [2026-11-07-2045](2026-11-07-2045-tasks-only-threads-inside.md) and [2026-11-07-2230](2026-11-07-2230-one-icon-per-task-state.md) on how attempts are labelled

- Runs with the same Agent (follow-ups, waiting for a reply, the factory's review, verify and fix) are one continuous conversation: no 「第 N 次尝试」 divider and no 「· 再试」 between them.
- Where a factory stage starts, a small marker says which: 「独立审查」, 「验证」, 「修复」. It comes from the run's `stage` when the server sends it; with no stage there is no marker.
- Only a switch to another Agent (Claude Code ↔ Codex ↔ Cursor) divides the conversation: 「换 Claude Code 继续」, or 「第 1 次尝试失败 · 换 Claude Code 再试」 when the run before failed. 「第 N 次」 counts Agent switches only.
- 活动 on the task page shows one row per Agent's stretch: 「Codex · 等你回复 · 11月5日」 with the latest run's state and date, and 「换 Claude Code」 where the task switched. A row opens the one conversation at its first run.
