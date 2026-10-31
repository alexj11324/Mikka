# Personal vs workspace ownership (待 Alex 确认)

- Date: 2026-10-31
- Status: **draft, pending Alex's approval. Not in force.**
- Source: Alex, relayed by the coordinator: bots belong to a person;
  「不管你在哪个工作区，你都可以用自己账号」; copy the ChatGPT/Claude model of a
  personal workspace beside team workspaces. Research:
  [personal vs workspace](../research/2026-10-31-personal-vs-workspace.md)
- Rule: —
- Replaces: —

Mikka has three levels:

1. **Account**: identity, sign-in, preferences, notifications, memory,
   app connections, saved logins, devices and model subscriptions.
2. **Personal workspace**: one per person, with only that person as a member.
3. **Team workspace**: members, policies, secrets, the E2B key, points and
   billing.

A bot lives in one workspace and has one owner.

A credential runs only its owner's bots, in any workspace the owner belongs
to. It never runs another member's bot. A workspace admin can limit personal
items in their workspace by turning off an app, a device type or personal
subscriptions (all on by default), but never owns or sees them.

Subscription runs use the owner's plan quota. Mikka 默认 and Mikka Cloud bill
the workspace the run belongs to. Work with no workspace of its own bills the
personal workspace.

Pending choices are listed in the research doc's open questions (§8).
