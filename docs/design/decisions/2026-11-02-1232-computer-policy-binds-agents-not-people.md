# The 电脑 policy binds Agents, not people

- Date: 2026-11-02
- Source: the coordinating Claude session's decision on
  [#959](https://github.com/alexj11324/Mikka/issues/959), 2026-11-02 (option b),
  based on [0330](2026-11-02-0330-computer-policy-gates-computer-tasks-only.md).
  It applies Alex's rule in [1050](2026-11-02-1050-desktop-lifecycle.md) that
  nobody watches a thread's desktop (#958).
- Rule: —
- Replaces: the "opening a thread desktop" gate in 0330.

The workspace 电脑 policy decides what Agents may do on a computer. It never
decides what a person may do on their own Bot's desktop.

- **Under deny, the owner** can still view and take over the Bot's desktop
  (`ComputerStore.operate`, `lib/computer/store.ts`).
- **Under deny, the Agent** is refused: every lease carries
  `computerAllowed=false`, so the driver, browser and credential broker refuse
  its actions, including after the owner hands back.
- **A thread's desktop** has no way in for anyone (1050), so the policy has no
  person-facing gate there. `POST /api/threads/[runId]/machine` takes only
  `pause`, `resume` and `end`.
