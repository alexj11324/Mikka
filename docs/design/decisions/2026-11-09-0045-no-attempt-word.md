# No 「尝试」 on iOS

- Date: 2026-11-09
- Source: Alex, relayed by the coordinator: drop the word 「尝试」 entirely, everywhere on iOS.
- Rule: `apps/mobile/features/tasks/model/task-conversation.ts` (`boundary`, `agentRunTitle`)
- Amends: [2026-11-08-2140](2026-11-08-2140-task-one-conversation.md) on the divider's words

- No 「第 N 次尝试」 and no numbering of runs anywhere: dividers, 活动, cards, headers.
- Runs with the same Agent stay one continuous conversation with nothing between them.
- A switch to another Agent is a divider 「换 Codex 继续」. When the run before it failed, the divider names the Agent that did not get through: 「Claude Code 没跑通 · 换 Codex 继续」.
- 活动 keeps one row per Agent's stretch; the row where the task switched reads 「换 Codex」.
