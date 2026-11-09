# Threads group in five, and an outcome judge decides resolved

- Date: 2026-11-01
- Source: Alex, on the Coordinator's 已解决（16）holding ZHIX-2 README runs that
  failed or stalled ("Not logged in · Please run /login", "I couldn't open the
  PR", 「我没有创建 PR，gh 拿不到凭证」): 「这明明是 block，你为什么分到了 resolve
  里面？是否解决也要用 decision API 来决定。block 之类的东西明显不应该放到 resolve
  里面。」 Then: 「应该是 5 档：Running、Blocked、Waiting for you、Idle、Resolved」.
  Relayed by the coordinator session.
- Rule: R-52
- Superseded in part by: [2026-11-09-0045](2026-11-09-0045-no-attempt-word.md) (no 「尝试」 in the UI: a task is one conversation; only an Agent switch gets a divider)
- Superseded in part by: [2026-11-07-2045](2026-11-07-2045-tasks-only-threads-inside.md) (lists group tasks as 等待你, 进行中, 待办 and 已完成; outcome judgement remains).
- Replaces: [decisions.md](../decisions.md) 2026-10-28 row "Thread lists group as
  等待回复 → 进行中 → 空闲 → 已解决 (… failed under 等待回复 …)", as to the groups
- Superseded in part by: [2026-11-02-0300](2026-11-02-0300-waiting-for-you-first.md) (等待你 is the first group)

Thread lists, on the web and the phone, group as 进行中 · 受阻 · 等待你 · 空闲 ·
已解决 (Running, Blocked, Waiting for you, Idle, Resolved); 已解决 stays collapsed.

- 进行中 follows the run's state. Every other group follows the run's judged
  outcome: when a run ends, the decision model reads its last reply, status,
  task and PRs and answers done, blocked, needs_input, failed or idle. The
  outcome, who judged it and why are stored on the run. When it gives no
  answer nothing is guessed: the outcome stays empty and it is asked again an
  hour later, as other non-write judgments do.
- 已解决 only for a done outcome, a closed task or a merged PR. Blocked, failed
  and needs_input never resolve. A run not judged yet sits under 受阻 (it
  failed) or 等待你, never 已解决.
- A task's existing threads fold into its newest (「第 N 次尝试」), which stays
  out of 已解决 while the task is unresolved; the task's page lists every
  attempt. New work keeps one thread per task (retries continue in it), so the
  fold is for threads that already exist.
- Runs that ended in the last 7 days before this change are judged by the
  same sweep; older ones keep no outcome.
