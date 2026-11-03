# New platform tools reach existing Coordinators without a re-save

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session after the Coordinator said
  it had no `github_tools`: new platform tools must appear automatically in
  existing Coordinators; people must not have to re-save, but an owner's
  deliberate removal of a tool in a version they saved is respected.
- Rule: —
- Replaces: —

Stored definitions and running executions are never rewritten. Each new
execution works out its tools when it starts:

- A stored copy of the built-in definition (source `builtin`, never edited by
  the owner) gets the current built-in tool list, and keeps any computer tools
  it already had.
- A version the owner saved (or an approved improvement, which keeps its base's
  tools) keeps its own list, plus every built-in tool that joined the platform
  after that version was created. A built-in tool that already existed then
  and is missing was removed on purpose and is not added back.
- `PLATFORM_TOOL_ADDED` in `lib/agent-kit/registry.ts` records when each tool
  joined the built-in definition (merge commit time, UTC), against the tool
  list of #355 when stored versions began. A new built-in tool needs a line
  there; a unit test fails without it.
- Every existing limit still applies to tools added this way: scheduled
  read-only turns get only their read allowlist, rollout gates and native
  scope checks run as for any other tool, and the mailbox and write-planning
  paths still require the tool in the saved definition itself.
