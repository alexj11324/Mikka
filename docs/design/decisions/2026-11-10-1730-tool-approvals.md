# A run's tool approvals come from its policy, and its read-only intent comes from the run

- Date: 2026-11-10
- Source: #1730 asked for a per-thread Plan / Execute / Ask switch. Reading
  the reference product end to end showed it has no such enum: `planMode`,
  `executeMode`, `askMode`, `permissionMode`, `canUseTool`,
  `bypassPermissions` and `acceptAutoEdits` all have zero occurrences there.
  Permission is a property of the **resource** being reached (a nullable
  `device` block with `capability`, `status` and `standing`), and "read only"
  is an instruction the person writes, not a mode. PR #1886 copied a
  three-state mode instead, and that is what this decision replaces.
- Rule: nothing stores a per-task mode. Two independent facts answer the two
  questions that one enum had merged:
  - **Does this run change anything?** The existing read-only policy
    (ADR 0046), set on the run's own `agentDefinition.readOnly`. It needs no
    per-harness matrix and no transition API.
  - **Does this specific call wait for a person?** The policy layer that
    resolved that action to `ask`. Claude Code and Codex have a native
    per-call callback (`canUseTool`, Codex's native approvals); Cursor's ACP
    bridge accepts every tool, so `HARNESS_TOOL_APPROVAL` reports it
    `unsupported` and a run that must ask is refused at claim.
- Removed: `task_thread_modes`, `agent_runs.mode`, `GET|POST
  /api/threads/:runId/mode`, `lib/thread-mode/*`, the picker and its hook,
  `devices.harnesses[].threadModes`, and the `THREAD_MODES` identifier.

What follows:

- `read_only` is the existing read-only policy applied to the run. The host
  tool paths refuse writes too: app tools return `runReadOnly`, a personal
  MCP tool call is refused, and the daemon gives Claude Code a read-only
  `canUseTool` allowlist and Codex its native `read-only` sandbox. A read-only
  run has no task branch and publishes nothing.
- A policy with no gate-expressible `ask` action asks nothing per call, which
  is the behavior every run had before approvals existed (decision
  2026-11-01-2335). Only `install_dependency` is gate-expressible:
  `write_outside_repo` is enforced by the sandbox denying the path and
  `computer_use` by its own broker, and both default to `ask`, so routing
  them through the CLI callback would change every run's behavior.
- An approval is one exact request bound to one run
  (`agent_tool_approvals`): `decidedBy` records who answered, `tool` names
  what was asked, and a decision attempted after the TTL stores `expired`.
  Nothing here grants agent or workspace authority, and a decline, timeout,
  lost lease or changed policy revision is never an allow.
- A continuation, retry, quota continuation, question continuation and cloud
  recovery all carry the source run's read-only intent on the **new run**.
  There is no shared row, so there is nothing to revert and no `(userId,
  issueId)` owner to argue about.

Cost if wrong: a thread cannot change its read-only intent mid-run; the next
run carries the new value. There is no per-thread "ask for everything"
switch — a workspace that wants one sets `install_dependency: ask` (or the
person's approval mode to `ask`, which is a personal layer).
