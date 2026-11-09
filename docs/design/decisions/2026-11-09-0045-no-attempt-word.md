# No 「尝试」 in the UI: a task is one conversation

- Date: 2026-11-09
- Source: Alex, relayed by the coordinator: drop the word 「尝试」 entirely, everywhere on iOS; then the same on the web (2026-11-09).
- Rule: iOS `apps/mobile/features/tasks/model/task-conversation.ts` (`boundary`, `agentRunTitle`); web: the hosted task-conversation, thread-header and task-column slots, and `Shell.panel.task.switch` / `switchAfterFailure` / `switchRow`
- Amends: [2026-11-08-2140](2026-11-08-2140-task-one-conversation.md) on the divider's words
- Supersedes, in part: [2026-11-01-1250](2026-11-01-1250-five-thread-groups.md) (「第 N 次尝试」 on a folded thread), [2026-11-07-2045](2026-11-07-2045-tasks-only-threads-inside.md) and [2026-11-07-2300](2026-11-07-2300-one-conversation-per-task.md) (attempts in 活动, numbered dividers between attempts), and [2026-11-08-1230](2026-11-08-1230-coding-workspace.md) R0b's 活动 wording

- No 「第 N 次尝试」 and no numbering of runs anywhere: dividers, 活动, cards, headers.
- Runs with the same Agent stay one continuous conversation with nothing between them.
- A switch to another Agent is a divider 「换 Codex 继续」. When the run before it failed, the divider names the Agent that did not get through: 「Claude Code 没跑通 · 换 Codex 继续」.
- 活动 keeps one row per Agent's stretch; the row where the task switched reads 「换 Codex」.

## Web and the wider rule

- A task is one conversation, on iOS and the web. 「尝试」 / "attempt" never appears in user-facing copy: not in the conversation, 活动, cards, headers, the thread list or errors.
- "Attempt" stays an internal data term only: `factory_attempts`, `agent_runs.attempt`, a run chain's runs, `?attempt=` in a push link. Docs that describe data may use it; docs that describe what a person sees do not.
- The web conversation follows the same rules: no per-run 「第 N 次尝试 · Agent · 时间 · 机器」 line (the conversation's header names the Agent), runs by the same Agent read on without a break, and only a switch of Agent gets a divider, 「换 Codex 继续」 or 「Claude Code 没跑通 · 换 Codex 继续」. The web 活动 lists one row per Agent stretch as iOS does: 「Codex · 失败 · 昨天」, then 「换 Claude Code · 等你回复 · …」.
- Factory stages follow [2026-11-04-2200](2026-11-04-2200-factory-flow-like-warp.md): the review is one result card, and only 修复 gets a small marker.
- Dated acceptance and audit records keep their wording; they are history.
