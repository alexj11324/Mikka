# Thread visibility follows Warp

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: 「按照他们的去做，我们的和他们不一样的话，以他们的为准」 (they = Warp Factories)
- Rule: R-62
- Replaces: [2026-11-01-2245-thread-privacy-and-local-isolation](2026-11-01-2245-thread-privacy-and-local-isolation.md) rule 1 (only the starter sees a thread), and its rule 2's "from the remote `main`" (see rule 3 below; the rest of rule 2 stands).

1. **A thread a bot or the Coordinator dispatches in a workspace is a Warp
   Factories run.** By default every member who can access that bot sees it:
   the live session while it runs and the full transcript after. Teammates
   only watch; they cannot send messages. Warp does not say this; it is
   Mikka's own rule.
2. **A person's private chat with the Coordinator is a Warp personal agent
   conversation.** By default only its owner sees it. The owner can share it:
   with the whole team (the default scope), with chosen people, or with
   anyone who has the link. People it is shared with view it; they can ask
   for edit access, and once the owner approves, they send instructions in
   it. Without edit access, continuing it forks a copy.
3. **One thread is one task; an issue can have several threads.** A thread on
   a person's own computer starts a new branch from the remote's default
   branch (usually `main`, never only `main`). When the work needs it, the
   Agent starts from another remote branch, such as the branch an earlier
   thread for the same issue already pushed. It uses only what is pushed to
   the remote, never the person's local checkout or uncommitted changes, and
   runs in a sandbox (an isolated worktree). The daemon already does this:
   a new thread for an issue starts from that issue's pushed branch
   (`packages/daemon/src/runs/supervisor.ts:1063-1082`), else from the
   repository's `baseBranch`, else `origin/HEAD`
   (`packages/daemon/src/repositories.ts:60-68`).

## What Warp's documentation says

- Runs: "the runs you have access to across your team"; Inbox shows "only
  the items waiting on you personally"
  ([Factory dashboard](https://docs.warp.dev/factories/factory-dashboard/)).
  View session follows the agent in real time and, after the sandbox shuts
  down, opens the transcript.
- The lowest role, Factory user, can "view the factory and run work"
  ([Permissions](https://docs.warp.dev/factories/permissions/)).
- Shared conversations: "By default, shared conversations are visible to
  anyone on your team"; scopes are the team, specific people, or anyone with
  the link; continuing someone else's shared conversation "creates a fork"
  ([Cloud conversations](https://docs.warp.dev/agents/local-agents/cloud-conversations/)).
- Session sharing: some participants only view, and a viewer may request edit
  access, which the sharer can approve
  ([Session sharing](https://docs.warp.dev/agent-platform/local-agents/session-sharing/)).

## Warp 未说明

- Whether a run can be limited to the person who started it.
- Who, besides the initiator, may send follow-up instructions to a run (the
  dashboard says a run's session takes follow-ups while its sandbox is
  active). Mikka's rule 1 makes teammates view-only.
- Who can see an unshared personal conversation (only that it stays with the
  account across machines).
- Whether a shared conversation can be kept view-only with no way to ask for
  edit access. Rule 2 follows Warp's session sharing: edit access on request,
  granted by the sharer.
