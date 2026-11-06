# Every task has its own Mikka number; Linear's is only a reference

- Date: 2026-11-06
- Source: Alex, 2026-11-06, after a dispatched workspace task never opened its pull request because it had no number: 「确实是要有编号啊，你应该强制用编号才对啊……BOT 提交任务时就必须把编号填上呀，不允许留空。」 and 「我们这边的编号跟 Linear 那边的编号是不一样的呀。我们不跟着 Linear 走啊，我们只是说同步而已。」
- Rule: —
- Replaces: MIK-46's rule that a workspace task shows its Linear identifier

Every task gets its number when it is created, from every entry point
(Coordinator, bots, web, MCP, Telegram, Slack). It is never empty.

- A workspace task is named by its team: the team key and the next number in
  that team (`AL-12`), like Linear. It gets a new number when it moves to
  another team.
- A personal task uses its owner's prefix and number (`ALEX-12`). An owner who
  has not chosen a prefix uses the email default, else `TASK`.

The Mikka number is the only primary number. Every place that names a task
uses it: lists, detail, chat chips, Factory, the task branch
(`mikka/al-12`) and the pull request title. A synced Linear identifier is an
outside reference to the Linear copy ("synced to Linear MIK-12"). It never
replaces the Mikka number, whether sync is on or off.

The database enforces it, so no entry point can skip it. Triggers assign the
number on insert (`assign_issue_number`, `assign_team_issue_number`). The task
number is required (`issues_number_required`), and team numbers are not null
and unique per team. The display rule is `taskIdentifier` in
`lib/task-identifier.ts`.
