# Thread visibility follows Warp

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: 「按照他们的去做，我们的和他们不一样的话，以他们的为准」 (they = Warp Factories)
- Rule: R-62
- Replaces: [2026-11-01-2245-thread-privacy-and-local-isolation](2026-11-01-2245-thread-privacy-and-local-isolation.md) rule 1 (only the starter sees a thread). Its rule 2 (a device thread starts a new branch from the remote `main` and runs in a sandbox) stands.

1. **A thread a bot or the Coordinator dispatches in a workspace is a Warp
   Factories run.** By default every member who can access that bot sees it:
   the live session while it runs and the full transcript after. Teammates
   only watch; they cannot send messages.
2. **A person's private chat with the Coordinator is a Warp personal agent
   conversation.** By default only its owner sees it. The owner can share it:
   with the whole team (the default scope), with chosen people, or with
   anyone who has the link. People it is shared with only view; to continue,
   they fork a copy.

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
- Whether view-only access to a shared conversation can be enforced. Warp's
  session sharing lets a sharer grant edit access on request; Mikka's rule 2
  keeps shared chats view-only, with a fork to continue.
